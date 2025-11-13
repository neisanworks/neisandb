import assert from "node:assert";

// biome-ignore lint: Using Object instead of object to assert item !== null
export function assertIsObject(item: unknown, message?: string): asserts item is Object {
	assert(typeof item === "object" && item !== null && !Array.isArray(item), message);
}
