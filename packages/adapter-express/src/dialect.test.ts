import { describe, expect, it } from "vitest";
import { DIALECTS } from "./dialect";

describe("DIALECTS", () => {
  it("sqlite spec", () => {
    expect(DIALECTS.sqlite.core).toBe("drizzle-orm/sqlite-core");
    expect(DIALECTS.sqlite.tableFn).toBe("sqliteTable");
    expect(DIALECTS.sqlite.configDialect).toBe("sqlite");
    expect(DIALECTS.sqlite.driverDep).toHaveProperty("better-sqlite3");
  });
  it("pgsql + mysql cores", () => {
    expect(DIALECTS.pgsql.core).toBe("drizzle-orm/pg-core");
    expect(DIALECTS.pgsql.tableFn).toBe("pgTable");
    expect(DIALECTS.mysql.core).toBe("drizzle-orm/mysql-core");
    expect(DIALECTS.mysql.tableFn).toBe("mysqlTable");
  });
});
