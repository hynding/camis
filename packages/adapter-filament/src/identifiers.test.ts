import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { strapiApiBundle } from "./strapi-api/__fixtures__/strapi-api";

// MySQL refuses an identifier over 64 characters and PostgreSQL cuts one at 63, so every
// constraint and index a migration names (or Laravel names for it: table_columns_suffix) fits 63.
const MAX = 63;

const migrations = filamentAdapter
  .generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" })
  .files.filter((f) => f.path.startsWith("database/migrations/"));

/** Every name Laravel gives (or is given) a key or index in a migration. */
const names = (php: string): string[] => {
  const out: string[] = [];
  for (const block of php.split(/Schema::(?:create|table)\(/).slice(1)) {
    const table = /^'([^']+)'/.exec(block)?.[1] ?? "";
    for (const m of block.matchAll(/foreignId\('([^']+)'\)[^;]*?->constrained\(([^)]*)\)/g)) {
      const named = /indexName: '([^']+)'/.exec(m[2] ?? "")?.[1];
      out.push(named ?? `${table}_${m[1]}_foreign`);
    }
    for (const m of block.matchAll(/->foreign\('([^']+)'(?:, '([^']+)')?\)/g))
      out.push(m[2] ?? `${table}_${m[1]}_foreign`);
    for (const m of block.matchAll(/->unique\(\[([^\]]+)\](?:, '([^']+)')?\)/g))
      out.push(m[2] ?? `${table}_${(m[1] ?? "").replace(/'/g, "").split(/,\s*/).join("_")}_unique`);
  }
  return out;
};

describe("migration identifiers", () => {
  it("names every key and index within 63 characters, nested repeatables' included", () => {
    const all = migrations.flatMap((f) => names(f.content));
    expect(all).toContain("menus_items_children_menu_items_id_foreign");
    expect(all.filter((n) => n.length > MAX)).toEqual([]);
  });

  it("keeps a name that already fits as Laravel gives it", () => {
    const all = migrations.flatMap((f) => names(f.content));
    expect(all).toContain("menus_items_menu_id_foreign");
  });
});
