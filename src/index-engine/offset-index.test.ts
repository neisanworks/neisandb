import { expect, test } from "bun:test";
import path from "node:path";
import { OffsetIndex } from "./record-index.js";

test(
	"Index Creation Test",
	async () => {
		const filepath = path.join(__dirname, "test.index");
		const index = new OffsetIndex(filepath);

		const numbers = Array.from({ length: 6000 }, (_, i) => i);

		for (const i of numbers.slice(0, 5000)) {
			await index.insert(i, i, i);
		}

		await index.flush();

		await Promise.all(
			numbers.slice(0, 5000).map(async (i) => {
				const offset = await index.find(i, i);
				expect(offset).toBe(i);
			}),
		);

		for (const i of numbers.slice(5000)) {
			await index.insert(i, i, i);
		}

		await Promise.all(
			numbers.slice(5000).map(async (i) => {
				const offset = await index.find(i, i);
				expect(offset).toBe(i);
			}),
		);

		expect(index.tree.size).toEqual(0);
	},
	{ timeout: 120 * 1000 },
);
