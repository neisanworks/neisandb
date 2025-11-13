import { expect, test } from "bun:test";
import assert from "node:assert";
import z from "zod/v4";
import type { Data } from "../types.js";
import { DataStore } from "./collection.js";
import { DataBase } from "./database.js";
import { Model } from "./model.js";

test("DataBase Test", async () => {
	const database = new DataBase();

	const UserSchema = z.object({
		email: z.email(),
		password: z.string().min(8).max(100),
		attempts: z.number().min(0).default(0),
	});
	type UserSchema = typeof UserSchema;

	class UserModel extends Model<UserSchema> {
		email!: string;
		password!: string;
		attempts: number = 0;

		constructor(data: Data, id: number) {
			super(UserSchema, id);
			this.hydrate(data);
		}

		get locked(): boolean {
			return this.attempts >= 3;
		}
	}

	const Users = database.collection({
		name: "users",
		model: UserModel,
		schema: UserSchema,
		uniques: ["email"],
	});
	expect(Users).toBeInstanceOf(DataStore);

	const insertion = await Users.insert({
		email: "email@email.com",
		password: "Password1",
	});
	expect(insertion.success).toBe(true);
	assert(insertion.success === true);
	expect(insertion.data).toBeInstanceOf(UserModel);
	expect(insertion.data.email).toBe("email@email.com");
	expect(insertion.data.password).toBe("Password1");
	expect(insertion.data.attempts).toBe(0);
	expect(insertion.data.locked).toBe(false);

	const conflict = await Users.insert({
		email: "email@email.com",
		password: "Password1",
	});
	expect(conflict.success).toBe(false);
	assert(conflict.success === false);

	let user = await Users.findOne(insertion.data.id);
	expect(user).toBeInstanceOf(UserModel);
	assert(user instanceof UserModel);
	expect(user.id).toBe(insertion.data.id);
	expect(user.email).toBe("email@email.com");
	expect(user.password).toBe("Password1");
	expect(user.attempts).toBe(0);

	user = await Users.findOne((record) => record.email === "email@email.com");
	expect(user).toBeInstanceOf(UserModel);
	assert(user instanceof UserModel);
	expect(user.email).toBe("email@email.com");
	expect(user.password).toBe("Password1");
	expect(user.attempts).toBe(0);

	const users = await Users.find((record) => record.email === "email@email.com");
	expect(users).toBeArray();
	assert(Array.isArray(users));
	for (const user of users) {
		expect(user.email).toBe("email@email.com");
	}

	expect(() => {
		user.email = "email";
	}).toThrow(z.ZodError);

	const update = await Users.findOneAndUpdate(0, (user) => {
		user.email = "newemail@email.com";
		return user;
	});
	expect(update.success).toBe(true);
	assert(update.success === true);
	expect(update.data).toBeInstanceOf(UserModel);

	const deleted = await Users.findAndDelete((user) => user.email === "email@email.com");
	expect(deleted.success).toBe(true);
	assert(deleted.success === true);
	expect(deleted.data).toBeArray();
	await Users.flush();
});
