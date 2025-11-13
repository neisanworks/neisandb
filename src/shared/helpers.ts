import assert from "node:assert";

// biome-ignore lint: Using Object instead of object to assert item !== null
export function assertIsObject(item: unknown, message?: string): asserts item is Object {
	assert(typeof item === "object" && item !== null && !Array.isArray(item), message);
}

export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
