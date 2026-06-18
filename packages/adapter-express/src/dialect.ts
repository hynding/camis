export type Dialect = "sqlite" | "mysql" | "pgsql";

export interface DialectSpec {
  dialect: Dialect;
  core: string; // drizzle-orm/<x>-core
  tableFn: string; // sqliteTable | pgTable | mysqlTable
  configDialect: string; // drizzle.config `dialect`
  idColumn: string; // the id primary-key column expression
  idImports: string[]; // imports the id column needs from `core`
  driverDep: Record<string, string>; // runtime driver dependency
  devDriverDep: Record<string, string>; // dev-only driver typings
  clientImports: string; // import lines for src/db/client.ts
  clientDb: string; // the `drizzle(...)` expression body
  configCredentials: string; // dbCredentials block for drizzle.config.ts
  timestamp: (col: string) => { expr: string; import: string }; // created_at/updated_at column
}

export const DIALECTS: Record<Dialect, DialectSpec> = {
  sqlite: {
    dialect: "sqlite",
    core: "drizzle-orm/sqlite-core",
    tableFn: "sqliteTable",
    configDialect: "sqlite",
    idColumn: `id: integer("id").primaryKey({ autoIncrement: true })`,
    idImports: ["integer"],
    driverDep: { "better-sqlite3": "^11.8.0" },
    devDriverDep: { "@types/better-sqlite3": "^7.6.0" },
    clientImports: `import Database from "better-sqlite3";\nimport { drizzle } from "drizzle-orm/better-sqlite3";`,
    clientDb: `drizzle(new Database(process.env.DB_FILE_NAME ?? "./data.db"), { schema })`,
    configCredentials: `dbCredentials: { url: process.env.DB_FILE_NAME ?? "./data.db" }`,
    timestamp: (c) => ({ expr: `integer("${c}", { mode: "timestamp" })`, import: "integer" }),
  },
  pgsql: {
    dialect: "pgsql",
    core: "drizzle-orm/pg-core",
    tableFn: "pgTable",
    configDialect: "postgresql",
    idColumn: `id: serial("id").primaryKey()`,
    idImports: ["serial"],
    driverDep: { postgres: "^3.4.0" },
    devDriverDep: {},
    clientImports: `import postgres from "postgres";\nimport { drizzle } from "drizzle-orm/postgres-js";`,
    clientDb: `drizzle(postgres(process.env.DATABASE_URL ?? ""), { schema })`,
    configCredentials: `dbCredentials: { url: process.env.DATABASE_URL ?? "" }`,
    timestamp: (c) => ({ expr: `timestamp("${c}")`, import: "timestamp" }),
  },
  mysql: {
    dialect: "mysql",
    core: "drizzle-orm/mysql-core",
    tableFn: "mysqlTable",
    configDialect: "mysql",
    idColumn: `id: int("id").primaryKey().autoincrement()`,
    idImports: ["int"],
    driverDep: { mysql2: "^3.11.0" },
    devDriverDep: {},
    clientImports: `import mysql from "mysql2/promise";\nimport { drizzle } from "drizzle-orm/mysql2";`,
    clientDb: `drizzle(mysql.createPool(process.env.DATABASE_URL ?? ""), { schema, mode: "default" })`,
    configCredentials: `dbCredentials: { url: process.env.DATABASE_URL ?? "" }`,
    timestamp: (c) => ({ expr: `timestamp("${c}")`, import: "timestamp" }),
  },
};
