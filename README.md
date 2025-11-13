# @neisanworks/neisandb

> A high-performance file-based local database for JavaScript/TypeScript. Leverages classes for models, allowing for methods and virtual properties while maintaining ease of setup.

---

## Type-safe. File-based. Zero-dependencies on heavy ORMs. Great for CLI and mobile development.

---

## Features

- Fully type-safe via TypeScript + Zod
- Strong runtime validation
- Class-based models with methods & virtuals
- Concurrency-safe (async-mutex + p-limit)
- Atomic file writes (temp + rename)
- File-backed, no server or DB setup
- Perfect for CLIs, bots, and tools

---

## Quick Start

### 1. Install

```bash
bun add @neisanworks/neisandb
# or
npm install @neisanworks/neisandb
# or
pnpm add @neisanworks/neisandb
```

### 2. Define a Schema and Model

```ts
// src/server/database/models/user.ts
import { type Data, Model } from '@neisanworks/neisandb';
import * as z from 'zod/v4';

export const UserSchema = z.object({
  email: z.email(),
  password: z.string().regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/),
  attempts: z.number().min(0).default(0)
});
export type UserSchema = typeof UserSchema;

export class UserModel extends Model<UserSchema> {
  email!: string;
  password!: string;
  attempts: number = 0
  
  constructor(data: Data, id: number) {
    super(UserSchema, id)
    this.hydrate(data)
  }
  
  get locked(): boolean {
    return this.attempts >= 3;
  }
  
  authenticate(password: string): boolean {
    return password === this.password;
  }
}
```

### 3. Initialize the Database and Collection(s)

```ts
// src/server/database/index.ts
import { Database } from '@neisanworks/neisandb'
import { UserModel, UserSchema } from './models/user.ts'

const db = new Database({
  folder: "./data", // optional
  concurrency: 25 // optional
})

export const Users = db.collection({
  name: 'users',
  model: UserModel,
  schema: UserSchema,
  uniques: ['email'] // optional
})
```

### 4. Use Your Collection(s)

```ts
// src/lib/remote/auth.remote.ts
import { error } from '@sveltejs/kit';
import { form } from '$app/server';
import { Users } from '$lib/server/database';
import { LoginSchema } from '$lib/utils/schemas/auth';

export const login = form(LoginSchema, async ({ email, password }) => {
  const user = await Users.findOne((user) => user.email === email);
  if (!user) {
    error(401, "Invalid Email/Password");
  };
  
  if (!user.authenticate(password)) {
    const update = await Users.findOneAndUpdate(user.id, (user) => {
      user.attempts++;
      return user;
    });
    
    if (update.success && update.data.locked) {
      error(423, "Account Locked; Contact System Admin");
    };
    error(401, "Invalid Email/Password");
  };
  
  return { message: "Authenticated" };
})
```

---

## Core Concepts

- Schema: Define shape and validation using `zod/v4`
- Model: Extends `Model` to use methods and virtual properties
- Collection: `db.collection({ name, model, schema })` defines a persistent collection
- Persistence: Each collection is backed by its own `.nsdb` file
- Validation: Validation occurs during record creation and each model property update

---

## Output Files

Each collection is stored in its own `.nsdb` file under your folder path

```
neisandb
├── data
│   └── users.tmp # Temporary file cteated during atomic file writing
│   └── users.nsdb # Users collection file
├── models
│   └── user.ts # Users collection model
└── index.ts # Database initialization and collection exporting (optional; collection can be created and exported anywhere)
```

---

## Collection Methods

`neisandb` supports a range of methods for querying, updating, and mutating

### Insert Method

- `insert`: creates a new record and returns it
```ts
const user = await Users.insert({ email: 'email@email.com', password: '$omePassw0rd' });
// Returns { success: false, errors: Record<keyof Schema, string> } | { success: true, data: UserModel }
```

### Query Methods

- `findOne`: returns one model from the database
```ts
// ID Query
const user = await Users.findOne(0);
// or, Predicate Search, returning the first to match
const user = await Users.findOne((user, id) => user.email === email);
```

- `find`: returns multiple models from the database
```ts
// No Parameter, returning all models from the database
const users = await Users.find();
// or, Predicate Search, returning all matching models from the database
const users = await Users.find((user, id) => id > 10);

// Pagination
const users = await Users.find({ offset: 5, limit: 10 });
// or
const users = await Users.find((user, id) => user.attempts < 3, { offset: 5, limit: 10 });
```

### Update Methods

- `findOneAndUpdate`: finds one record, update it, and return its model
```ts
// ID Query
const update = await Users.findOneAndUpdate(0, (user) => {
  user.email = 'newemail@email.com'; // validation occurs at the property-level in its setter-method
  return user; // must return user for update to occur
});
// or, Predicate Search, updating the first match
const update = await Users.findOneAndUpdate((user, id) => user.email === email, (user) => {
  user.email = 'newemail@email.com';
  return user;
});

// Returns { success: false, errors: { general } | { [keyof Schema]: string } } || { success: true, data: UserModel }
if (!update.success) {
  error(406, update.errors);
};
const user = update.data;
```

- `findAndUpdate`: finds multiple records, update them, and return the updated models
```ts
// No Query
const update = await Users.findAndUpdate((user) => {
  user.attempts = 3; // locks all users
  return user;
});
// or, Predicate Search, updating the matching records
const update = await Users.findAndUpdate((user, id) => user.attempts >= 3, (user) => {
  user.attempts = 0; // unlocks all locked users
  return user;
});

// Returns { success: false, errors: { general } | { [keyof Schema]: string } } || { success: true, data: Array<UserModel> }
if (!update.success) {
  error(406, update.errors);
};
const users = update.data;
```

### Delete Methods

- `findOneAndDelete`: finds one record, delete it, and return its model
```ts
// ID Query
const deletion = await Users.findOneAndDelete(0);
// or, Predicate Search, updating the first match
const deletion = await Users.findOneAndDelete((user, id) => user.email === email);
// Returns UserModel | undefined
```

- `findAndDelete`: finds multiple records, delete them, and return the deleted models
```ts
// Must supply query to reduce chance of collection deletion
// Predicate Search, deleting the matching records
const deletion = await Users.findAndDelete((user, id) => user.attempts >= 3);

// Returns { success: false, errors: { general } | { [keyof Schema]: string } } || { success: true, data: Array<UserModel> }
if (!deletion.success) {
  error(406, update.errors);
};
const users = deletion.data;
```

### Map Method

- `findAndMap`: finds multiple records, map over them, and return the mutated data
```ts
// No Parameter, mapping over all models from the database
const users = await Users.findAndMap((user) => {
  if (user.locked) return `User with email ${user.email} locked`;
  return `User with email ${user.email} unlocked`;
});
// or, Predicate Search, returning all matching models from the database
const users = await Users.find((user, id) => user.attempts >= 3, (user) => {
  if (user.locked) return `User with email ${user.email} locked`;
  return `User with email ${user.email} unlocked`;
});

// Pagination
const users = await Users.findAndMap((user) => {
  if (user.locked) return `User with email ${user.email} locked`;
  return `User with email ${user.email} unlocked`;
}, { offset: 5, limit: 10 });
// or
const users = await Users.find((user, id) => user.attempts >= 3, (user) => {
  if (user.locked) return `User with email ${user.email} locked`;
  return `User with email ${user.email} unlocked`;
}, { offset: 5, limit: 10 });

// Returns Array<UserModel> | undefined if no matches
```

### Additional Methods

- `count`: returns a count of how many records match
```ts
// No Query, returning the total number of records
const users = await Users.count();
// or, Predicate Search, returning the number of matches
const unlocked = await Users.count((user, id) => user.attempts < 3);
```

- `exists`: returns a count of how many records match
```ts
// ID Query
const exists = await Users.exists(0);
// or, Predicate Search, returning on the first match
const exists = await Users.exists((user, id) => user.email === 'email@email.com');
```

- `flush`: force a flush of in-memory records to the disk
```ts
await Users.flush();
```

---

## Relationships (Joins)

Though collections do not share relationships, the behavior of relationships can be mimiced

```ts
const message = await Users.findOneAndMap(
	(user, id) => {
		return user.email === "email@email.com";
	},
	async (user) => {
		const profile = await Profiles.findOne(user.profileID);
		if (profile) return `Welcome, ${profile.fullname}`;
	},
);
```

---

## Contributing
Found a bug or have an idea? Open an issue or PR.

---

## License
MIT — © 2025 neisanworks
