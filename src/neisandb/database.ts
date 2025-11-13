import path from "node:path";
import { Encoder } from "@neisanworks/neisan-encoder";
import pLimit, { type LimitFunction } from "p-limit";
import z from "zod/v4";
import type { ModelData } from "../types.js";
import { DataStore, type DSOptions } from "./collection.js";

export const DBOptionSchema = z.object({
	directory: z
		.string()
		.regex(/^(\/|\.\/|\.\.\/)?([\w.-]+\/)*[\w.-]+$/)
		.default(() => path.join(process.cwd(), "neisandb"))
		.transform((dir) => path.normalize(dir)),
	concurrency: z.number().min(1).max(100).default(25),
});
export type DBOptions = z.input<typeof DBOptionSchema>;

export class DataBase {
	directory: string;
	limiter: LimitFunction;
	encoder = new Encoder();

	constructor(options?: DBOptions) {
		const params = DBOptionSchema.parse(options ?? {});

		this.directory = params.directory;
		this.limiter = pLimit(params.concurrency);
	}

	collection<Schema extends z.ZodObject, Instance extends ModelData<Schema>>(
		options: DSOptions<Schema, Instance>,
	) {
		return new DataStore<Schema, Instance>(this, options);
	}
}
