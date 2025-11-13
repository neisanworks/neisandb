import { expect, test } from "bun:test";
import { Encoder } from "@neisanworks/neisan-encoder";
import z from "zod/v4";
import { register } from "./database.utils.js";
import { Model } from "./model.js";

const encoder = new Encoder();

test("Model Creation and Property Validation", () => {
	const UserSchema = z.object({
		email: z.email(),
		password: z.string().min(8).max(32),
		attempts: z.number().min(0).default(0),
		auth: z
			.object({
				teams: z.array(z.number()),
				admin: z.array(z.number()).optional(),
				meta: z
					.object({
						test: z.boolean(),
						teams: z.number(),
					})
					.optional(),
			})
			.optional(),
	});
	type UserSchema = typeof UserSchema;

	class UserModel extends Model<UserSchema> {
		email!: string;
		password!: string;
		attempts: number = 0;
		auth?: {
			teams: number[];
			admin?: number[];
			meta?: {
				test: boolean;
				teams: number;
			};
		};

		constructor(data: Record<PropertyKey, unknown>, id: number) {
			super(UserSchema, id);
			this.hydrate(data);
		}

		get locked(): boolean {
			return this.attempts >= 3;
		}
	}
	register(UserModel, encoder);

	const user = new UserModel({ email: "email@email.com", password: "something" }, 1);
	expect(user).toBeInstanceOf(UserModel);
	expect(user.email).toBe("email@email.com");
	expect(user.password).toBe("something");
	expect(user.attempts).toBe(0);
	expect(user.locked).toBe(false);

	expect(() => {
		user.auth = {
			teams: ["a", "b", "c"] as any,
		};
	}).toThrow(z.ZodError);

	user.auth = {
		teams: [1, 2, 3],
		admin: [4, 5, 6],
	};
	expect(user.auth.admin).toEqual([4, 5, 6]);

	user.auth.meta = {
		test: true,
		teams: 3,
	};

	expect(() => {
		// biome-ignore lint: user.auth was set in the lines above
		user.auth!.meta = { test: "nope", teams: 3 } as any;
	}).toThrow(z.ZodError);

	const encoded = encoder.encode(user);
	const decoded = encoder.decode(encoded);
	expect(decoded).toEqual(user);

	expect(() => {
		user.email = "invalid-email";
	}).toThrow(z.ZodError);

	const json = JSON.stringify(user);
	const parsed = JSON.parse(json);
	expect(parsed).toContainValues(Object.values(user));
});
