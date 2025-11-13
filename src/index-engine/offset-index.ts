import assert from "node:assert";
import { Encoder } from "@neisanworks/neisan-encoder";
import { BTree } from "@tylerbu/sorted-btree-es6";
import { Mutex, Semaphore } from "async-mutex";
import fs from "fs-extra";
import { FixedArray } from "../shared/fixed-array.js";
import { ID, LSN } from "../types.js";

const encoder = new Encoder();

type RecordKey = Record<"id" | "lsn", number>;

@encoder.encodable({
	encoded: (tree: IndexBTree) => {
		return Array.from(tree.entries());
	},
	reviver: (encoded) => {
		return new IndexBTree(encoded);
	},
})
class IndexBTree extends BTree<RecordKey, number> {
	constructor(entries?: Array<[RecordKey, number]>) {
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

export class OffsetIndex {
	private readonly path: string;
	private readonly start: 0 | 1 = 0;
	private readonly treesize: number = 1500;
	private readonly pagesize: number = 128 * 1024;

	private readonly cache = new FixedArray<IndexBTree>([], 5);
	private readonly reader = new Semaphore(10);
	private readonly writer = new Mutex();
	private readonly flusher = new Mutex();
	private flushTimeout: NodeJS.Timeout | undefined;

	tree = new IndexBTree();
	private lsn: number = -1;
	private filesize: number = 0;
	private lastFlushed: number = -1;

	constructor(pathname: string, start: 0 | 1 = 0) {
		this.path = pathname;
		this.start = start;

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
			this.tree = encoder.decode<IndexBTree>(buffer.subarray(8, length + 8));
			assert(this.tree instanceof IndexBTree);

			this.lsn = this.tree.keysArray().reduce<number>((acc, curr) => {
				return Math.max(acc, curr.lsn);
			}, -1);
			this.lastFlushed = this.lsn;

			if (this.tree.size >= this.treesize) this.tree = new IndexBTree();
		} finally {
			fs.closeSync(file);
		}
	}

	#position(lsn: number): number {
		lsn = LSN(lsn);
		return Math.floor((lsn - this.start) / this.treesize) * this.pagesize;
	}

	async insert(id: number, lsn: number, offset: number) {
		id = ID(id);
		lsn = LSN(lsn);

		if (lsn <= this.lsn) return;

		await this.writer.runExclusive(async () => {
			clearTimeout(this.flushTimeout);

			this.tree.set({ id, lsn }, offset);
			this.lsn = lsn;

			if (this.tree.size >= this.treesize) {
				await this.#flush(lsn);
				if (!this.cache.full) this.cache.insert(this.tree);
				this.tree = new IndexBTree();
			} else {
				this.flushTimeout = setTimeout(async () => {
					await this.#flush(lsn);
				}, 1000 * 30);
			}
		});
	}

	async #flush(lsn: number): Promise<void> {
		lsn = LSN(lsn);

		if (this.lastFlushed >= lsn) return;

		await this.flusher.runExclusive(async () => {
			await fs.ensureFile(this.path);

			const position = this.#position(lsn);

			const file = await fs.open(this.path, "r+");
			try {
				const encoded = encoder.encode(this.tree);
				if (encoded.length > this.pagesize - 8) {
					throw new Error("Encoded tree too large for page");
				}

				const buffer = Buffer.alloc(this.pagesize);
				const view = new DataView(buffer.buffer);
				view.setUint32(0, encoded.length, true);
				encoded.copy(buffer, 8);

				await fs.write(file, buffer, 0, this.pagesize, position);

				this.filesize += this.pagesize;
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

	async find(id: number, lsn: number): Promise<number | undefined> {
		id = ID(id);
		lsn = LSN(lsn);

		return this.reader.runExclusive(async () => {
			const entry = this.tree.getPairOrNextLower({ id, lsn });
			if (entry && entry[0].id === id) return entry[1];

			for (let i = this.cache.size - 1; i >= 0; i--) {
				const tree = this.cache.get(i);
				assert(tree instanceof IndexBTree);
				const entry = tree.getPairOrNextLower({ id, lsn });
				if (entry && entry[0].id === id) {
					if (i !== this.cache.size - 1) {
						this.cache.entries.splice(i, 1);
						this.cache.entries.push(tree);
					}
					return entry[1];
				}
			}

			try {
				await fs.access(this.path);
			} catch {
				return undefined;
			}

			let position = this.#position(lsn);
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
					const tree = encoder.decode<IndexBTree>(buffer.subarray(8, length + 8));
					assert(tree instanceof IndexBTree);

					const entry = tree.getPairOrNextLower({ id, lsn });

					if (entry && entry[0].id === id) {
						this.cache.insert(tree);
						return entry[1];
					}

					position -= this.pagesize;
				}
			} finally {
				await fs.close(file);
			}
		});
	}
}
