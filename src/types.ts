import * as z from "zod/v4";

// Utility Types
export type Prettier<T extends Record<PropertyKey, any>> = {
	[K in keyof T]: T[K];
} & {};
export type Data = Record<string, any>;

export const NoNegNumSchema = (message?: string) => z.coerce.number().min(0, message);
export type NoNegNumSchema = typeof NoNegNumSchema;
export const ID = (id: unknown) => NoNegNumSchema("Invalid ID").parse(id);
export const LSN = (lsn: unknown) => NoNegNumSchema("Invalid LSN").parse(lsn);
export const Integer = (num: unknown) => z.int().parse(num);

// Method Return
export type Success = { success: true };
export type Return<T> = { success: true; data: T };
export type Failure<T extends object = GeneralError> = { success: false; errors: T };
export type GeneralError = { general: string };

// Zod Types
export type SKey<Schema extends z.ZodObject> = keyof z.core.output<Schema>;
export type ParseFailure<Schema extends z.ZodObject> = z.ZodSafeParseError<
	| z.core.output<Schema>
	| z.core.$InferObjectOutput<
			{ [k in keyof Schema["shape"]]: z.ZodOptional<Schema["shape"][k]> },
			// biome-ignore lint: Must use empty object for type inference
			{}
	  >
>;
export type ParseErrors<Schema extends z.ZodObject> = Partial<
	Record<SKey<Schema>, string>
>;

// DataStore Types
export type SchemaPredicate<Schema extends z.ZodObject> = (
	record: z.core.output<Schema>,
	id: number,
) => boolean | Promise<boolean>;
export type ModelUpdater<
	Schema extends z.ZodObject,
	Instance extends ModelData<Schema>,
> = (model: Instance) => any | Promise<any>;
export type FindOptions = Partial<Record<"limit" | "offset", number>>;
export type ModelMapper<
	Schema extends z.ZodObject,
	Instance extends ModelData<Schema>,
	T,
> = (model: Instance) => T | Promise<T>;

// Database Model Types
export type WithoutID<Schema extends z.ZodObject> = z.core.output<Schema>;
export type ModelData<Schema extends z.ZodObject> = {
	id: number;
} & z.core.output<Schema>;
export type ModelCtor<Schema extends z.ZodObject, Model extends ModelData<Schema>> = new (
	data: Data,
	id: number,
) => Model;
