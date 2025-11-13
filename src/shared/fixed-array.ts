type SearchPredicate<T = string> = (item: T) => boolean;

export class FixedArray<T = string> {
	readonly entries: Array<T> = [];
	readonly limit: number;

	constructor(entries?: Array<T> | undefined, limit: number = 5) {
		this.limit = limit;
		(entries ?? []).forEach((entry) => {
			this.insert(entry);
		});
	}

	[Symbol.iterator]() {
		return this.entries[Symbol.iterator]();
	}

	get size(): number {
		return this.entries.length;
	}

	get full(): boolean {
		return this.size >= this.limit;
	}

	index(item: T): number | undefined {
		return this.entries.indexOf(item);
	}

	has(item: T): boolean {
		return this.entries.includes(item);
	}

	get(index: number): T | undefined {
		return this.entries.at(index);
	}

	search(predicate: SearchPredicate<T>): boolean {
		for (const entry of this.entries) {
			if (predicate(entry)) return true;
		}
		return false;
	}

	filter(predicate: SearchPredicate<T>): Array<T> {
		const result: Array<T> = [];
		for (const entry of this.entries) {
			if (predicate(entry)) result.push(entry);
		}
		return result;
	}

	map<U>(mapper: (item: T) => U): Array<U> {
		const result: Array<U> = [];
		for (const entry of this.entries) {
			result.push(mapper(entry));
		}
		return result;
	}

	insert(item: T): FixedArray<T> {
		if (this.size >= this.limit) {
			this.entries.splice(0, 1);
		}
		this.entries.push(item);
		return this;
	}
}
