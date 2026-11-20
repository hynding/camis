import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitApiScopeMethod } from "./api-scope";

const story: ContentType = {
  name: "Story",
  kind: "collection",
  fields: [
    { type: "string", name: "title" },
    { type: "string", name: "status" },
    { type: "relation", name: "owner", target: "User", relationKind: "manyToOne" },
  ],
};
const owns = {
  kind: "eq",
  left: { kind: "var", name: "record.ownerId" },
  right: { kind: "var", name: "user.id" },
} as const;
const published = {
  kind: "eq",
  left: { kind: "var", name: "record.status" },
  right: { kind: "lit", value: "published" },
} as const;

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// The content API's list shows each caller exactly the rows its policy's view lets through, in
// SQL, so the page's total and size count only those rows.
describe("emitApiScopeMethod", () => {
  const scope = emitApiScopeMethod(
    story,
    {
      unconditional: ["editor"],
      conditions: [
        { roles: ["authenticated"], condition: owns },
        { roles: ["reviewer"], condition: published },
      ],
    },
    { guests: false, tokens: false, open: false },
  );

  it("lists every row to a role reading outright, and to each other role what its condition lets through", () => {
    expect(scope.gaps).toEqual([]);
    expect(scope.exact).toBe(true);
    expect(scope.php)
      .toBe(`    /** Rows visible to $user (Strapi API style list scope): each role's read condition, in SQL. */
    public function scopeForUser(Builder $q, User $user): Builder
    {
        if ($user->hasAnyRole(['editor'])) {
            return $q;
        }

        return $q->where(function (Builder $q) use ($user): void {
            $q->whereRaw('1 = 0');
            if ($user->hasAnyRole(['authenticated'])) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('owner_id', '=', $user->id);
                });
            }
            if ($user->hasAnyRole(['reviewer'])) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('status', '=', 'published');
                });
            }
        });
    }`);
  });

  // Two roles reading under different conditions used to share the first one's list scope.
  it("keeps each role to its own condition rather than the first role's", () => {
    expect(scope.php).not.toContain("conditionConflict");
    expect(scope.php.match(/orWhere\(function/g)).toHaveLength(2);
  });

  it("lists every row to an API token, and to a public route where the project opens one", () => {
    const out = emitApiScopeMethod(
      story,
      { unconditional: [], conditions: [{ roles: ["authenticated"], condition: owns }] },
      { guests: false, tokens: true, open: true },
    );
    expect(out.php).toContain("public function scopeForUser(Builder $q, ?User $user): Builder");
    expect(out.php).toContain(
      "        if (\\App\\Support\\StrapiApiTokens::active() || \\App\\Http\\Middleware\\StrapiPublicRoute::active()) {\n            return $q;\n        }",
    );
  });

  // A guest has no id, so a condition naming the user lets it see none of the rows; a condition
  // on the row alone holds for a guest as for anyone.
  it("asks a guest its public role's condition without the user", () => {
    const out = emitApiScopeMethod(
      story,
      {
        unconditional: [],
        conditions: [
          { roles: ["authenticated"], condition: owns },
          { roles: ["public"], condition: published },
        ],
      },
      { guests: true, tokens: false, open: false },
    );
    expect(out.exact).toBe(true);
    expect(out.php).toContain("public function scopeForUser(Builder $q, ?User $user): Builder");
    expect(out.php)
      .toContain(`            if ($user !== null && $user->hasAnyRole(['authenticated'])) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('owner_id', '=', $user->id);
                });
            }
            if ($user === null) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('status', '=', 'published');
                });
            }`);
  });

  it("lists every row to a guest whose public role reads outright", () => {
    const out = emitApiScopeMethod(
      story,
      { unconditional: ["public"], conditions: [{ roles: ["authenticated"], condition: owns }] },
      { guests: true, tokens: false, open: false },
    );
    expect(out.php).toContain("        if ($user === null) {\n            return $q;\n        }");
  });

  // SQL cannot say it, so the scope lets the role's rows through and the controller filters them
  // through the policy before it pages: the list stays right, only slower.
  it("lets a role whose condition is outside SQL through, and says the list must filter", () => {
    const out = emitApiScopeMethod(
      story,
      {
        unconditional: [],
        conditions: [{ roles: ["authenticated"], condition: { kind: "not", arg: published } }],
      },
      { guests: false, tokens: false, open: false },
    );
    expect(out.exact).toBe(false);
    expect(out.php).toContain(
      "            if ($user->hasAnyRole(['authenticated'])) {\n                $q->orWhereRaw('1 = 1');\n            }",
    );
    expect(out.gaps.map((g) => g.feature)).toEqual(["listScopeFallback"]);
    expect(out.gaps[0]!.location).toEqual({ contentType: "Story", rule: "authenticated" });
  });

  it("lists every row where no role reads under a condition", () => {
    const out = emitApiScopeMethod(story, undefined, {
      guests: false,
      tokens: false,
      open: false,
    });
    expect(out.exact).toBe(true);
    expect(out.php).toContain("        return $q;\n    }");
  });

  it.skipIf(!hasPhp())("lints clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-scope-"));
    try {
      const file = join(dir, "Story.php");
      writeFileSync(
        file,
        `<?php\n\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Builder;\n\nclass Story\n{\n${scope.php}\n}\n`,
      );
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain(
        "No syntax errors detected",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
