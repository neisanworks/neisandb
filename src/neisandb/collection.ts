import assert from "node:assert";
import path from "node:path";
import { Encoder } from "@neisanworks/neisan-encoder";
import { BTree } from "@tylerbu/sorted-btree-es6";
import { Mutex, Semaphore } from "async-mutex";
import fs from "fs-extra";
import type { LimitFunction } from "p-limit";
import z from "zod/v4";
import { FixedArray } from "../shared/fixed-array.js";
import {
	type Data,
	type Failure,
	type FindOptions,
	ID,
	LSN,
	type ModelCtor,
	type ModelData,
	type ModelMapper,
	type ModelUpdater,
	type ParseErrors,
	type Return,
	type SchemaPredicate,
	type SKey,
} from "../types.js";
import type { DataBase } from "./database.js";

export type DataTreeEntry<Schema extends z.ZodObject> = [
	Record<"lsn" | "id", number>,
	z.core.output<Schema> | "DELETED",
];
export type DataTreeEntries<Schema extends z.ZodObject> = Array<DataTreeEntry<Schema>>;
export type DataTreeCtor<Schema extends z.ZodObject> = new (
	entries?: DataTreeEntries<Schema>,
) => DataTree<Schema>;

export class DataTree<Schema extends z.ZodObject> extends BTree<
	Record<"lsn" | "id", number>,
	z.core.output<Schema> | "DELETED"
> {
	constructor(entries?: DataTreeEntries<Schema>) {
		super(
			entries,
			(a, b) => {
				if (a.id === b.id) return a.lsn - b.lsn;
				return a.id - b.id;
			},
			10,
		);
	}
}

export type DSOptions<Schema extends z.ZodObject, Instance extends ModelData<Schema>> = {
	name: string;
	model: new (data: Data, id: number) => Instance;
	schema: Schema;
	autoload?: boolean;
	uniques?: Array<SKey<Schema>>;
	indexed?: Array<SKey<Schema>>;
	idStart?: 0 | 1;
};

export class DataStore<Schema extends z.ZodObject, Instance extends ModelData<Schema>> {
	private readonly path: string;

	private readonly limiter: LimitFunction;
	private readonly encoder = new Encoder();

	private readonly reader = new Semaphore(10);
	private readonly writer = new Mutex();
	private readonly flusher = new Mutex();

	private readonly Tree: DataTreeCtor<Schema>;
	private tree: DataTree<Schema>;
	private readonly cache = new FixedArray<DataTree<Schema>>([], 5);

	private readonly treesize: number = 1500;
	private readonly pagesize: number = 1024 * 256;

	private readonly start: 0 | 1;
	private id: number = -1;
	private lsn: number = -1;
	private filesize: number = 0;

	private flushTimeout: NodeJS.Timeout | undefined;
	private lastFlushed: number = -1;

	readonly schema: Schema;
	readonly model: ModelCtor<Schema, Instance>;

	readonly uniques: Set<SKey<Schema>>;

	constructor(db: DataBase, options: DSOptions<Schema, Instance>) {
		this.path = path.join(db.directory, "data", `${options.name}.nsdb`);

		this.limiter = db.limiter;

		this.Tree = DataTree;
		this.encoder.encodable({
			encoded: (tree: DataTree<Schema>) => {
				return Array.from(tree.entries());
			},
			reviver: (entries) => {
				return new this.Tree(entries);
			},
		})(this.Tree);
		this.tree = new this.Tree();

		this.start = options.idStart ?? 0;

		this.schema = options.schema;
		this.model = options.model;

		this.uniques = new Set(options.uniques);

		if (!fs.existsSync(this.path)) return;

		const size = fs.statSync(this.path).size;
		this.filesize = size;
		if (size === 0) return;

		const pages = Math.floor(size / this.pagesize);
		const position = (pages - 1) * this.pagesize;
		if (position < 0) return;

		const file = fs.openSync(this.path, "r");
		try {
			const buffer = Buffer.alloc(this.pagesize);
			fs.readSync(file, buffer, 0, this.pagesize, position);

			const length = buffer.subarray(0, 8).readUInt32LE(0);
			this.tree = this.encoder.decode<DataTree<Schema>>(buffer.subarray(8, length + 8));
			assert(this.tree instanceof DataTree);

			this.id = this.tree.keysArray().reduce<number>((acc, curr) => {
				return Math.max(acc, curr.id);
			}, -1);
			this.lsn = this.tree.keysArray().reduce<number>((acc, curr) => {
				return Math.max(acc, curr.lsn);
			}, -1);
			this.lastFlushed = this.lsn;

			if (this.tree.size >= this.treesize) this.tree = new this.Tree();
		} finally {
			fs.closeSync(file);
		}
	}

	get nextID(): number {
		this.id++;
		return this.id;
	}

	get nextLSN(): number {
		this.lsn++;
		return this.lsn;
	}

	#noMatchFailure(): Failure {
		return { success: false, errors: { general: "No Document Matches" } };
	}

	#schemaFailure(failure: z.ZodError): Failure<ParseErrors<Schema>> {
		const errors: ParseErrors<Schema> = {};
		z.treeifyError(failure, (issue) => {
			const path = issue.path.at(0);
			if (path) errors[path as SKey<Schema>] = issue.message;
		});
		return { success: false, errors };
	}

	#uniqueConflictFailure(key: SKey<Schema>): Failure<ParseErrors<Schema>> {
		return {
			success: false,
			errors: { [key]: "Conflict as unique key" },
		} as Failure<ParseErrors<Schema>>;
	}

	async #concurrent<T, U>(
		items: Iterable<T>,
		callback: (item: T, index: number, array: Array<T>) => Promise<U>,
	): Promise<Array<U>> {
		return Promise.all(
			Array.from(items).map((item, index, array) =>
				this.limiter(async () => await callback(item, index, array)),
			),
		);
	}

	#position(lsn: number): number {
		lsn = Math.max(0, lsn);
		return Math.floor((lsn - this.start) / this.treesize) * this.pagesize;
	}

	async #flush(lsn: number): Promise<void> {
		lsn = LSN(lsn);

		if (this.lastFlushed >= lsn) return;

		await this.flusher.runExclusive(async () => {
			await fs.ensureFile(this.path);

			const position = this.#position(lsn);

			const file = await fs.open(this.path, "r+");
			try {
				const encoded = this.encoder.encode(this.tree);
				if (encoded.length > this.pagesize - 8) {
					throw new Error("Encoded tree too large for page");
				}

				const buffer = Buffer.alloc(this.pagesize);
				const view = new DataView(buffer.buffer);
				view.setUint32(0, encoded.length, true);
				encoded.copy(buffer, 8);

				await fs.write(file, buffer, 0, this.pagesize, position);

				const filesize = position + this.pagesize;
				if (filesize > this.filesize) this.filesize = filesize;

				this.lastFlushed = lsn;
			} finally {
				await fs.close(file);
			}
		});
	}

	async flush(): Promise<void> {
		clearTimeout(this.flushTimeout);
		await this.#flush(this.lsn);
	}

	async #checkUniques(
		checked: Data,
		id: number,
	): Promise<Failure<ParseErrors<Schema>> | undefined> {
		let conflict: SKey<Schema> | undefined;
		const seen = new Set<number>();

		await this.flusher.waitForUnlock();

		const check = async (tree: DataTree<Schema>) => {
			for (const [key, record] of tree.entriesReversed()) {
				if (conflict) break;
				if (seen.has(key.id)) continue;
				seen.add(key.id);

				for (const unique of this.uniques) {
					if (
						record !== "DELETED" &&
						record[unique] === checked[String(unique)] &&
						key.id !== id
					) {
						conflict = unique;
						break;
					}
				}
			}
		};

		await check(this.tree);
		if (conflict) return this.#uniqueConflictFailure(conflict);

		try {
			await fs.access(this.path);
		} catch {
			return;
		}

		let position = this.#position(this.lsn) - this.filesize;
		if (position > this.filesize) return;

		const file = await fs.open(this.path, "r");

		const buffer = Buffer.alloc(this.pagesize);
		try {
			await this.flusher.waitForUnlock();

			while (position >= 0) {
				const read = await fs.read(file, buffer, 0, this.pagesize, position);
				if (read.bytesRead === 0) {
					position -= this.pagesize;
					continue;
				}

				const length = buffer.subarray(0, 8).readUInt32LE(0);
				const tree = this.encoder.decode<DataTree<Schema>>(
					buffer.subarray(8, length + 8),
				);
				assert(tree instanceof DataTree);

				await check(tree);
				if (conflict) return this.#uniqueConflictFailure(conflict);

				position -= this.pagesize;
			}
		} finally {
			await fs.close(file);
		}
	}

	async count(): Promise<number>;
	async count(predicate: SchemaPredicate<Schema>): Promise<number>;
	async count(predicate?: SchemaPredicate<Schema>): Promise<number> {
		return this.reader.runExclusive(async () => {
			let count: number = 0;
			const seen = new Set<number>();

			const match = async (tree: DataTree<Schema>) => {
				for (const [key, record] of tree.entriesReversed()) {
					if (seen.has(key.id)) continue;
					seen.add(key.id);

					if (record === "DELETED") continue;

					if (!predicate || (await predicate(record, key.id))) {
						count++;
					}
				}
			};

			await match(this.tree);

			try {
				await fs.access(this.path);
			} catch {
				return count;
			}

			let position = this.filesize - this.pagesize;
			if (position < 0) return count;

			await this.flusher.waitForUnlock();
			const file = await fs.open(this.path, "r");

			const buffer = Buffer.alloc(this.pagesize);
			try {
				while (position >= 0) {
					const read = await fs.read(file, buffer, 0, this.pagesize, position);
					if (read.bytesRead === 0) {
						position -= this.pagesize;
						continue;
					}

					const length = buffer.subarray(0, 8).readUInt32LE(0);
					const tree = this.encoder.decode<DataTree<Schema>>(
						buffer.subarray(8, length + 8),
					);
					assert(tree instanceof DataTree);

					await match(tree);

					position -= this.pagesize;
				}
			} finally {
				await fs.close(file);
			}

			return count;
		});
	}

	async exists(id: number): Promise<boolean>;
	async exists(predicate: SchemaPredicate<Schema>): Promise<boolean>;
	async exists(search: number | SchemaPredicate<Schema>): Promise<boolean> {
		const match =
			typeof search === "number"
				? await this.findOne(search)
				: await this.findOne(search);
		return match !== undefined;
	}

	async insert(
		data: z.core.input<Schema>,
	): Promise<Failure<ParseErrors<Schema>> | Return<Instance>> {
		return this.writer.runExclusive(async () => {
			await this.flusher.waitForUnlock();

			const parsed = await this.schema.safeParseAsync(data);
			if (!parsed.success) {
				return this.#schemaFailure(parsed.error);
			}

			const conflict = await this.#checkUniques(parsed.data, Infinity);
			if (conflict) return conflict;

			this.tree.set({ lsn: this.nextLSN, id: this.nextID }, parsed.data);

			if (this.tree.size >= this.treesize) {
				await this.#flush(this.lsn);
				this.cache.insert(this.tree);
				this.tree = new this.Tree();
			} else {
				this.flushTimeout = setTimeout(async () => {
					await this.#flush(this.lsn);
				}, 1000 * 30);
			}

			return { success: true, data: new this.model(parsed.data, this.id) };
		});
	}

	async findOne(id: number): Promise<Instance | undefined>;
	async findOne(predicate: SchemaPredicate<Schema>): Promise<Instance | undefined>;
	async findOne(search: number | SchemaPredicate<Schema>): Promise<Instance | undefined> {
		return this.reader.runExclusive(async () => {
			if (typeof search === "number") {
				search = ID(search);
				if (search > this.id) return;
			}

			const lsn = this.lsn;
			const seen = new Set<number>();

			const findRecord = async (
				tree: DataTree<Schema>,
			): Promise<Instance | undefined> => {
				if (typeof search === "function") {
					let match: Instance | undefined;

					for (const [key, record] of tree.entriesReversed()) {
						if (match) break;
						if (key.lsn > lsn || seen.has(key.id)) continue;
						seen.add(key.id);

						if (record === "DELETED") continue;

						if (await search(record, key.id)) {
							match = new this.model(record, key.id);
						}
					}

					return match;
				} else {
					const entry = tree.getPairOrNextLower({ lsn, id: search });
					if (entry && entry[0].id === search) {
						if (entry[1] === "DELETED") return;
						return new this.model(entry[1], search);
					}
				}
			};

			const inMemory = await findRecord(this.tree);
			if (inMemory) return inMemory;

			for (const tree of this.cache.reversedEntries()) {
				const cached = await findRecord(tree);
				if (cached) return cached;
			}

			try {
				await fs.access(this.path);
			} catch {
				return undefined;
			}

			await this.flusher.waitForUnlock();
			let position = this.#position(lsn);
			if (position > this.filesize) return;

			const file = await fs.open(this.path, "r");

			const buffer = Buffer.alloc(this.pagesize);
			try {
				while (position >= 0) {
					const read = await fs.read(file, buffer, 0, this.pagesize, position);
					if (read.bytesRead === 0) {
						position -= this.pagesize;
						continue;
					}

					const length = buffer.subarray(0, 8).readUInt32LE(0);
					const tree = this.encoder.decode<DataTree<Schema>>(
						buffer.subarray(8, length + 8),
					);
					assert(tree instanceof DataTree);

					const onDisk = await findRecord(tree);
					if (onDisk) return onDisk;

					position -= this.pagesize;
				}
			} finally {
				await fs.close(file);
			}
		});
	}

	async findOneAndUpdate(
		id: number,
		updater: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Instance>>;
	async findOneAndUpdate(
		predicate: SchemaPredicate<Schema>,
		updater: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Instance>>;
	async findOneAndUpdate(
		search: number | SchemaPredicate<Schema>,
		updater: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Instance>> {
		return this.writer.runExclusive(async () => {
			const found =
				typeof search === "number"
					? await this.findOne(search)
					: await this.findOne(search);

			if (!found) return this.#noMatchFailure();

			try {
				const updated = await updater(found);
				const record = this.schema.parse(updated);

				const conflict = await this.#checkUniques(record, updated.id);
				if (conflict) return conflict;

				this.tree.set({ id: found.id, lsn: this.nextLSN }, record);

				if (this.tree.size >= this.treesize) {
					await this.#flush(this.lsn);
					this.cache.insert(this.tree);
					this.tree = new this.Tree();
				} else {
					this.flushTimeout = setTimeout(async () => {
						await this.#flush(this.lsn);
					}, 1000 * 30);
				}

				return { success: true, data: updated };
			} catch (error: any) {
				if (error instanceof z.ZodError) {
					return this.#schemaFailure(error);
				}
				return { success: false, errors: { general: error.message } };
			}
		});
	}

	async findOneAndDelete(id: number): Promise<Instance | undefined>;
	async findOneAndDelete(
		predicate: SchemaPredicate<Schema>,
	): Promise<Instance | undefined>;
	async findOneAndDelete(
		search: number | SchemaPredicate<Schema>,
	): Promise<Instance | undefined> {
		return this.writer.runExclusive(async () => {
			const found =
				typeof search === "number"
					? await this.findOne(search)
					: await this.findOne(search);

			if (!found) return;

			this.tree.set({ id: found.id, lsn: this.nextLSN }, "DELETED");

			if (this.tree.size >= this.treesize) {
				await this.#flush(this.lsn);
				this.cache.insert(this.tree);
				this.tree = new this.Tree();
			} else {
				this.flushTimeout = setTimeout(async () => {
					await this.#flush(this.lsn);
				}, 1000 * 30);
			}

			return found;
		});
	}

	async find(options?: FindOptions): Promise<Array<Instance> | undefined>;
	async find(
		predicate: SchemaPredicate<Schema>,
		options?: FindOptions,
	): Promise<Array<Instance> | undefined>;
	async find(
		arg_1?: FindOptions | SchemaPredicate<Schema>,
		arg_2?: FindOptions,
	): Promise<Array<Instance> | undefined> {
		return this.reader.runExclusive(async () => {
			const predicate = typeof arg_1 === "function" ? arg_1 : undefined;
			const options: FindOptions = typeof arg_1 === "object" ? arg_1 : (arg_2 ?? {});

			const seen = new Set<number>();
			const matches: Array<Instance> = [];

			const match = async (tree: DataTree<Schema>) => {
				for (const [key, record] of tree.entriesReversed()) {
					if (seen.has(key.id)) continue;
					seen.add(key.id);

					if (record === "DELETED") continue;

					if (predicate) {
						const valid = await predicate(record, key.id);
						if (!valid) continue;
					}
					matches.push(new this.model(record, key.id));
				}
			};

			await this.flusher.waitForUnlock();
			const lsn = this.lsn;

			await match(this.tree);

			if (lsn + this.start < this.treesize) {
				const limited = matches.slice(options.offset ?? 0, options.limit ?? Infinity);
				return limited.length > 0 ? limited : undefined;
			}

			try {
				await fs.access(this.path);
			} catch {
				const limited = matches.slice(options.offset ?? 0, options.limit ?? Infinity);
				return limited.length > 0 ? limited : undefined;
			}

			let position = this.#position(lsn);
			if (position < 0) {
				const limited = matches.slice(options.offset ?? 0, options.limit ?? Infinity);
				return limited.length > 0 ? limited : undefined;
			} else if (position === this.filesize - this.pagesize) {
				position -= this.pagesize;
			}

			const file = await fs.open(this.path, "r");

			const buffer = Buffer.alloc(this.pagesize);
			try {
				await this.flusher.waitForUnlock();

				while (position >= 0) {
					const read = await fs.read(file, buffer, 0, this.pagesize, position);
					if (read.bytesRead === 0) {
						position -= this.pagesize;
						continue;
					}

					const length = buffer.subarray(0, 8).readUInt32LE(0);
					const tree = this.encoder.decode<DataTree<Schema>>(
						buffer.subarray(8, length + 8),
					);
					assert(tree instanceof DataTree);

					await match(tree);

					position -= this.pagesize;
				}

				const limited = matches.slice(options.offset ?? 0, options.limit ?? Infinity);
				return limited.length > 0 ? limited : undefined;
			} finally {
				await fs.close(file);
			}
		});
	}

	async findAndMap<T>(
		mapper: ModelMapper<Schema, Instance, T>,
		options?: FindOptions,
	): Promise<Array<T> | undefined>;
	async findAndMap<T>(
		predicate: SchemaPredicate<Schema>,
		mapper: ModelMapper<Schema, Instance, T>,
		options?: FindOptions,
	): Promise<Array<T> | undefined>;
	async findAndMap<T>(
		arg_1: ModelMapper<Schema, Instance, T> | SchemaPredicate<Schema>,
		arg_2?: ModelMapper<Schema, Instance, T> | FindOptions,
		arg_3?: FindOptions,
	): Promise<Array<T> | undefined> {
		let predicate: SchemaPredicate<Schema> | undefined;
		let mapper: ModelMapper<Schema, Instance, T>;
		let options: FindOptions = {};

		if (typeof arg_2 === "function") {
			predicate = arg_1 as SchemaPredicate<Schema>;
			mapper = arg_2;
			options = arg_3 ?? {};
		} else {
			mapper = arg_1 as ModelMapper<Schema, Instance, T>;
			options = arg_2 ?? {};
		}

		await this.flusher.waitForUnlock();
		const matches = predicate
			? await this.find(predicate, options)
			: await this.find(options);
		if (!matches) return;

		const mapped: Array<T> = [];
		await this.#concurrent(matches, async (match) => {
			try {
				mapped.push(await mapper(match));
			} catch {}
		});

		return mapped.length > 0 ? mapped : undefined;
	}

	async findAndUpdate(
		updater: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Array<Instance>>>;
	async findAndUpdate(
		predicate: SchemaPredicate<Schema>,
		updater: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Array<Instance>>>;
	async findAndUpdate(
		arg_1: ModelUpdater<Schema, Instance> | SchemaPredicate<Schema>,
		arg_2?: ModelUpdater<Schema, Instance>,
	): Promise<Failure | Failure<ParseErrors<Schema>> | Return<Array<Instance>>> {
		return await this.writer.runExclusive(async () => {
			const predicate = arg_2 ? (arg_1 as SchemaPredicate<Schema>) : undefined;
			const updater = arg_2 ? arg_2 : (arg_1 as ModelUpdater<Schema, Instance>);

			await this.flusher.waitForUnlock();
			const matches = predicate ? await this.find(predicate) : await this.find();

			if (!matches) return this.#noMatchFailure();

			clearTimeout(this.flushTimeout);

			const results: Array<Instance> = [];
			let error: Failure | Failure<ParseErrors<Schema>> | undefined;

			await this.#concurrent(matches, async (match) => {
				if (error) return;

				try {
					const updated = await updater(match);
					const record = this.schema.parse(updated);

					const conflict = await this.#checkUniques(record, match.id);
					if (conflict) return conflict;

					this.tree.set({ id: match.id, lsn: this.nextLSN }, record);

					if (this.tree.size >= this.treesize) {
						await this.#flush(this.lsn);
						this.cache.insert(this.tree);
						this.tree = new this.Tree();
					}

					results.push(updated);
				} catch (e: any) {
					if (e instanceof z.ZodError) {
						error = this.#schemaFailure(e);
					}
					error = { success: false, errors: { general: e.message } };
				}
			});

			this.flushTimeout = setTimeout(async () => {
				await this.#flush(this.lsn);
			}, 1000 * 30);

			if (error) return error;

			return { success: true, data: results };
		});
	}

	async findAndDelete(
		predicate: SchemaPredicate<Schema>,
	): Promise<Failure | Return<Array<Instance>>> {
		return this.writer.runExclusive(async () => {
			await this.flusher.waitForUnlock();
			const matches = await this.find(predicate);

			if (!matches) return this.#noMatchFailure();

			clearTimeout(this.flushTimeout);

			await this.#concurrent(matches, async (match) => {
				this.tree.set({ id: match.id, lsn: this.nextLSN }, "DELETED");

				if (this.tree.size >= this.treesize) {
					await this.#flush(this.lsn);
					this.cache.insert(this.tree);
					this.tree = new this.Tree();
				}
			});

			this.flushTimeout = setTimeout(async () => {
				await this.#flush(this.lsn);
			}, 1000 * 30);

			return { success: true, data: matches };
		});
	}
}
