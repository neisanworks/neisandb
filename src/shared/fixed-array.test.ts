import { expect, test } from "bun:test";
import { FixedArray } from "./fixed-array.js";

test("FixedArray Test", () => {
	const array = new FixedArray<number>([], 5);

	const five = Array.from({ length: 5 }, (_, i) => i);
	five.forEach((i) => {
		array.insert(i);
	});
	expect(array.entries).toEqual(five);

	array.insert(5);
	expect(array.entries).toBeArrayOfSize(5);
	expect(array.entries).toEqual(five.slice(1).concat(5));
});
