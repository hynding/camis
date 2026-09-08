import { describe, expect, it } from "vitest";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitScopeMethod } from "./scope";

const ct = (n: string) => strapiApiBundle.document.contentTypes.find((c) => c.name === n)!;
const cond = (n: string) =>
  strapiApiBundle.roles[0]!.grants.find((g) => g.contentType === n)!.condition;

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
