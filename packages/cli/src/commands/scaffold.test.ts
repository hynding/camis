import { describe, expect, it } from "vitest";
import type { Io } from "../io";
import { patchUserModel, scaffoldCommand } from "./scaffold";

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

const fakeIo = (opts: {
  files?: Record<string, string>;
  execResults?: number[];
}): { io: Io; calls: ExecCall[]; lines: string[]; written: Record<string, string> } => {
  const calls: ExecCall[] = [];
  const lines: string[] = [];
  const written: Record<string, string> = {};
  const files = opts.files ?? {};
  const execResults = opts.execResults ?? [];
  const io: Io = {
    readFile: (p) =>
      p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
    writeFile: (p, c) => {
      written[p] = c;
      return Promise.resolve();
    },
    materialize: () => Promise.resolve(),
    copyDir: () => Promise.resolve(),
    exec: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return Promise.resolve(execResults[calls.length - 1] ?? 0);
    },
    out: (l) => lines.push(l),
    cwd: "/proj",
  };
  return { io, calls, lines, written };
};

const STOCK_USER = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Factories\\HasFactory;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;
use Illuminate\\Notifications\\Notifiable;

class User extends Authenticatable
{
    use HasFactory, Notifiable;
}
`;

describe("patchUserModel", () => {
  it("adds the HasRoles trait to the stock User model", () => {
    const patched = patchUserModel(STOCK_USER);
    expect(patched).toContain(
      "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles;",
    );
  });

  it("is idempotent", () => {
    const once = patchUserModel(STOCK_USER);
    expect(patchUserModel(once)).toBe(once);
  });
});

describe("scaffoldCommand", () => {
  it("runs the composer/artisan sequence in order and patches User.php", async () => {
    const { io, calls, written } = fakeIo({
      files: { "/proj/app/app/Models/User.php": STOCK_USER },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`.trim())).toEqual([
      "composer create-project",
      "composer require",
      "php artisan",
      "php artisan",
      "composer require",
      "php artisan",
    ]);
    expect(calls[0]!.args).toContain("laravel/laravel:^12");
    expect(calls[0]!.cwd).toBe("/proj");
    expect(calls[1]!.args).toContain("filament/filament:^5.0");
    expect(calls[1]!.cwd).toBe("/proj/app");
    expect(calls[2]!.args).toEqual(["artisan", "filament:install", "--panels", "--no-interaction"]);
    expect(calls[3]!.args).toEqual(["artisan", "install:api", "--no-interaction"]);
    expect(calls[4]!.args).toContain("spatie/laravel-permission");
    expect(calls[5]!.args.join(" ")).toContain("vendor:publish");
    expect(written["/proj/app/app/Models/User.php"]).toContain("HasRoles");
  });

  it("refuses a directory that already has composer.json", async () => {
    const { io, calls, lines } = fakeIo({
      files: { "/proj/app/composer.json": "{}" },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("already");
  });

  it("aborts on the first failing step", async () => {
    const { io, calls } = fakeIo({ execResults: [0, 1] });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("rejects unknown scaffold targets", async () => {
    const { io, lines } = fakeIo({});
    const code = await scaffoldCommand("strapi", "app", io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("filament");
  });
});
