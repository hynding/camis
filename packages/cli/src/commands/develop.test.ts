import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import type { Io } from "../io";
import { developCommand, developEnv, patchDevelopEnv } from "./develop";

const config = JSON.stringify({
  ir: "./camis.json",
  roles: "./roles.json",
  targets: [
    { target: "strapi", out: "./generated/cms" },
    { target: "filament", out: "./generated/filament", apiStyle: "strapi" },
  ],
});
const ir = JSON.stringify({
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
});
const roles = JSON.stringify({ roles: [{ name: "super-admin", admin: true, grants: [] }] });

const fakeIo = (
  files: Record<string, string>,
  ran: { cmd: string; args: string[]; cwd: string }[],
  lines: string[],
): Io => ({
  readFile: (p) => {
    const content = files[p] ?? (p.endsWith("camis.config.json") ? config : undefined);
    if (content !== undefined) return Promise.resolve(content);
    if (p.endsWith("camis.json")) return Promise.resolve(ir);
    if (p.endsWith("roles.json")) return Promise.resolve(roles);
    return Promise.reject(new Error(`ENOENT: ${p}`));
  },
  writeFile: (p, c) => {
    files[p] = c;
    return Promise.resolve();
  },
  materialize: () => Promise.resolve(),
  makeDir: () => Promise.resolve(),
  copyDir: () => Promise.resolve(),
  exec: (cmd, args, cwd) => {
    ran.push({ cmd, args, cwd });
    return Promise.resolve(0);
  },
  out: (l) => lines.push(l),
  cwd: "/p",
});

// `strapi develop`: the project built, the admin's Content-Type Builder able to edit, then served.
describe("camis develop", () => {
  it("tells the app where the project is and how to rebuild it", () => {
    expect(
      developEnv({
        project: "/p/camis.config.json",
        node: "/usr/bin/node",
        bin: "/c/camis.mjs",
        apps: ["/p/generated/filament", "/p/generated/admin2"],
      }),
    ).toEqual({
      CAMIS_PROJECT_CONFIG: "/p/camis.config.json",
      CAMIS_BUILD_COMMAND: "/usr/bin/node /c/camis.mjs build --config /p/camis.config.json",
      // Every app an edit rebuilds, so the one it was made in brings each database up to it.
      CAMIS_DEVELOP_APPS: `/p/generated/filament${delimiter}/p/generated/admin2`,
    });
  });

  it("quotes a path a shell would split", () => {
    expect(
      developEnv({ project: "/my p/c.json", node: "node", bin: "/c/camis.mjs", apps: [] })
        .CAMIS_BUILD_COMMAND,
    ).toBe('node /c/camis.mjs build --config "/my p/c.json"');
  });

  it("sets the builder's lines in .env, replacing earlier ones and keeping the rest", () => {
    const env = { CAMIS_PROJECT_CONFIG: "/p/c.json", CAMIS_BUILD_COMMAND: 'node x build "/my p"' };
    const once = patchDevelopEnv("APP_ENV=local\nCAMIS_PROJECT_CONFIG=/old.json\n", env);
    expect(once).toBe(
      'APP_ENV=local\nCAMIS_PROJECT_CONFIG="/p/c.json"\nCAMIS_BUILD_COMMAND="node x build \\"/my p\\""\n',
    );
    expect(patchDevelopEnv(once, env)).toBe(once);
  });

  it("builds, wires the Strapi-style Filament app, syncs its database and serves it", async () => {
    const files: Record<string, string> = {
      "/p/generated/filament/.env": "APP_ENV=local\nDB_CONNECTION=sqlite\n",
    };
    const ran: { cmd: string; args: string[]; cwd: string }[] = [];
    const lines: string[] = [];
    const code = await developCommand("camis.config.json", fakeIo(files, ran, lines), {
      node: "/usr/bin/node",
      bin: "/c/camis.mjs",
      serve: true,
    });
    expect(code).toBe(0);
    expect(files["/p/generated/filament/.env"]).toContain(
      'CAMIS_PROJECT_CONFIG="/p/camis.config.json"',
    );
    expect(ran).toEqual([
      {
        cmd: "php",
        args: ["artisan", "camis:schema-sync"],
        cwd: "/p/generated/filament",
      },
      { cmd: "php", args: ["artisan", "serve"], cwd: "/p/generated/filament" },
    ]);
    expect(lines.join("\n")).toContain("Content-Type Builder");
  });

  // Every Strapi-style Filament app the project builds edits the content model, not only the first.
  it("wires and syncs every Strapi-style Filament target, serving the first", async () => {
    const files: Record<string, string> = {
      "/p/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [
          { target: "filament", out: "./generated/filament", apiStyle: "strapi" },
          {
            target: "filament",
            out: "./generated/storage",
            apiStyle: "strapi",
            storageLayout: "strapi",
          },
          { target: "filament", out: "./generated/admin2", apiStyle: "strapi" },
          { target: "filament", out: "generated/admin2", apiStyle: "strapi" },
        ],
      }),
    };
    const ran: { cmd: string; args: string[]; cwd: string }[] = [];
    const lines: string[] = [];
    const code = await developCommand("camis.config.json", fakeIo(files, ran, lines), {
      node: "node",
      bin: "camis.mjs",
      serve: true,
    });
    expect(code).toBe(0);
    for (const out of ["/p/generated/filament", "/p/generated/admin2"]) {
      expect(files[`${out}/.env`]).toContain('CAMIS_PROJECT_CONFIG="/p/camis.config.json"');
    }
    expect(files["/p/generated/storage/.env"]).toBeUndefined();
    expect(files["/p/generated/admin2/.env"]).toContain(
      `CAMIS_DEVELOP_APPS="/p/generated/filament${delimiter}/p/generated/admin2"`,
    );
    expect(ran.map((r) => `${r.cwd} ${r.args.join(" ")}`)).toEqual([
      "/p/generated/filament artisan camis:schema-sync",
      "/p/generated/admin2 artisan camis:schema-sync",
      "/p/generated/filament artisan serve",
    ]);
  });

  it("serves the target --target names", async () => {
    const files: Record<string, string> = {
      "/p/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [
          { target: "filament", out: "./generated/filament", apiStyle: "strapi" },
          { target: "filament", out: "./generated/admin2", apiStyle: "strapi" },
        ],
      }),
    };
    const ran: { cmd: string; args: string[]; cwd: string }[] = [];
    const lines: string[] = [];
    const io = fakeIo(files, ran, lines);
    const options = { node: "node", bin: "camis.mjs", serve: true };
    expect(
      await developCommand("camis.config.json", io, { ...options, target: "generated/admin2" }),
    ).toBe(0);
    expect(ran.at(-1)).toEqual({
      cmd: "php",
      args: ["artisan", "serve"],
      cwd: "/p/generated/admin2",
    });

    // As the config names it, wherever camis runs from.
    const fromRoot = { ...fakeIo(files, ran, lines), cwd: "/" };
    expect(
      await developCommand("/p/camis.config.json", fromRoot, {
        ...options,
        target: "./generated/admin2",
      }),
    ).toBe(0);
    expect(ran.at(-1)).toEqual({
      cmd: "php",
      args: ["artisan", "serve"],
      cwd: "/p/generated/admin2",
    });

    expect(await developCommand("camis.config.json", io, { ...options, target: "./nowhere" })).toBe(
      1,
    );
    expect(lines.at(-1)).toContain('no Strapi-style Filament target is out at "./nowhere"');
  });

  it("refuses a project with no Strapi-style Filament target to edit from", async () => {
    const lines: string[] = [];
    const io = fakeIo(
      {
        "/p/camis.config.json": JSON.stringify({
          ir: "./camis.json",
          targets: [{ target: "filament", out: "./generated/filament" }],
        }),
      },
      [],
      lines,
    );
    const code = await developCommand("camis.config.json", io, {
      node: "node",
      bin: "camis.mjs",
      serve: false,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain('apiStyle "strapi"');
  });
});
