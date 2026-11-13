import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { CREATED_BY, CREATOR_SHARES_ROLE } from "@camis/permissions";
import { emitAdminScopeMethod } from "./admin-scope";

const story: ContentType = {
  name: "Story",
  kind: "collection",
  fields: [
    { type: "string", name: "title" },
    { type: "string", name: "status" },
  ],
};
const isCreator = {
  kind: "eq",
  left: { kind: "var", name: CREATED_BY },
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

// Strapi lists in the Content Manager only the entries a role's read condition lets through: an
// Author sees the entries it created, not a list of every entry it then may not open.
describe("emitAdminScopeMethod", () => {
  const scope = emitAdminScopeMethod(story, {
    unconditional: ["editor"],
    conditions: [
      { roles: ["author"], condition: isCreator },
      { roles: ["reviewer"], condition: published },
    ],
  });

  it("lists every entry to a role reading outright, and to the others what their condition lets through", () => {
    expect(scope.gaps).toEqual([]);
    expect(scope.php)
      .toBe(`    /** Rows an admin account may list in the Content Manager, as its roles' read conditions allow. */
    public function scopeForAdmin(Builder $q, ?\\Illuminate\\Contracts\\Auth\\Authenticatable $user): Builder
    {
        if (! $user instanceof AdminUser) {
            return $q->whereRaw('1 = 0');
        }
        if ($user->hasAnyRole(['editor'])) {
            return $q;
        }

        return $q->where(function (Builder $q) use ($user): void {
            $q->whereRaw('1 = 0');
            if ($user->hasAnyRole(['author'])) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('created_by_id', '=', $user->id);
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

  it("lists the entries an account sharing one of the user's roles created", () => {
    const out = emitAdminScopeMethod(story, {
      unconditional: [],
      conditions: [
        {
          roles: ["reviewer"],
          condition: {
            kind: "or",
            args: [
              isCreator,
              {
                kind: "eq",
                left: { kind: "var", name: CREATOR_SHARES_ROLE },
                right: { kind: "lit", value: true },
              },
            ],
          },
        },
      ],
    });
    expect(out.gaps).toEqual([]);
    expect(out.php).toContain(
      "$q->where(function ($q) use ($user) { $q->where('created_by_id', '=', $user->id); $q->orWhereIn('created_by_id', \\App\\Models\\AdminUser::query()->select('id')->whereHas('roles', fn ($role) => $role->whereKey($user->roles->modelKeys()))); });",
    );
  });

  // A condition the list cannot put in SQL lists nothing for its roles, rather than every row.
  it("lists nothing for a role whose condition is outside SQL, and reports it", () => {
    const out = emitAdminScopeMethod(story, {
      unconditional: [],
      conditions: [{ roles: ["author"], condition: { kind: "not", arg: published } }],
    });
    expect(out.php).not.toContain("hasAnyRole(['author'])");
    expect(out.gaps.map((g) => g.feature)).toEqual(["adminListScope"]);
    expect(out.gaps[0]!.location).toEqual({ contentType: "Story", rule: "author" });
  });

  it.skipIf(!hasPhp())("lints clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "admin-scope-"));
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
