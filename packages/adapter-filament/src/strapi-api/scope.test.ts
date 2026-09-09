import { describe, expect, it } from "vitest";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { storageBundle } from "./storage/__fixtures__/storage";
import { emitScopeMethod } from "./scope";

const ct = (n: string) => strapiApiBundle.document.contentTypes.find((c) => c.name === n)!;
const cond = (n: string) =>
  strapiApiBundle.roles[0]!.grants.find((g) => g.contentType === n)!.condition;

const storageCt = (n: string) => storageBundle.document.contentTypes.find((c) => c.name === n)!;
const storageCond = (n: string) =>
  storageBundle.roles[0]!.grants.find((g) => g.contentType === n)!.condition;

describe("emitScopeMethod", () => {
  it("emits an Eloquent scope for a compilable condition", () => {
    const r = emitScopeMethod(ct("Activity"), cond("Activity"));
    expect(r.gap).toBeUndefined();
    expect(r.php).toContain("public function scopeForUser(Builder $q, User $user): Builder");
    expect(r.php).toContain("$q->orWhere('creator_id', '=', $user->id);");
  });
  it("falls back to an identity scope with a downgrade gap when not compilable", () => {
    const r = emitScopeMethod(ct("Activity"), { kind: "not", arg: cond("Note")! });
    expect(r.gap?.feature).toBe("listScopeFallback");
    expect(r.gap?.severity).toBe("downgrade");
    expect(r.php).toContain("return $q;");
  });
  it("emits an identity scope without a condition", () => {
    expect(emitScopeMethod(ct("Tag"), undefined).php).toContain("return $q;");
  });
});

describe("emitScopeMethod storage layout", () => {
  it("compiles the Note scope through the link table in the strapi layout", () => {
    const r = emitScopeMethod(storageCt("Note"), storageCond("Note"), "strapi");
    expect(r.gap).toBeUndefined();
    expect(r.php).toContain("whereExists");
    expect(r.php).toContain("notes_owner_lnk");
  });
  it("leaves the laravel layout (default) output unchanged", () => {
    const withDefault = emitScopeMethod(storageCt("Note"), storageCond("Note"));
    const withExplicit = emitScopeMethod(storageCt("Note"), storageCond("Note"), "laravel");
    expect(withDefault.php).toBe(withExplicit.php);
    expect(withDefault.php).not.toContain("whereExists");
    expect(withDefault.php).not.toContain("notes_owner_lnk");
    expect(withDefault.php).toContain("$q->where('owner_id', '=', $user->id);");
  });
});
