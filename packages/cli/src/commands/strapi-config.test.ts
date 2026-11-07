import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Io } from "../io";
import { readStrapiConfig, readStrapiPluginsConfig } from "./strapi-config";

const hasPhp = (() => {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const capture: NonNullable<Io["capture"]> = (cmd, args, cwd) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });

const project = async (file: string, content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "camis-strapi-config-"));
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config", file), content);
  return dir;
};

// What every loader must give back: literals as written, each env() read as a reference to the
// variable (never its value), and a reference spliced into text as ${NAME}.
const EXPECTED = {
  upload: {
    config: {
      provider: "aws-s3",
      sizeLimit: 1048576,
      providerOptions: {
        baseUrl: "${CDN_URL}/media",
        s3Options: {
          region: { env: "AWS_REGION", default: "eu-west-1" },
          forcePathStyle: { env: "S3_PATH_STYLE", default: false },
          params: { Bucket: { env: "AWS_BUCKET" } },
        },
      },
    },
  },
  email: { config: { provider: "nodemailer", providerOptions: { port: { env: "SMTP_PORT", default: 587 } } } },
};

describe("readStrapiPluginsConfig", () => {
  it("reads nothing from a project with no config/plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-strapi-config-"));
    expect(await readStrapiPluginsConfig(dir, capture)).toEqual({ ok: true, config: undefined });
  });

  it.skipIf(!hasPhp)("reads a strapi-php project's config/plugins.php", async () => {
    const dir = await project(
      "plugins.php",
      `<?php
declare(strict_types=1);
use Strapi\\Utils\\EnvHelper;
return static fn (EnvHelper $env): array => [
    'upload' => ['config' => [
        'provider' => 'aws-s3',
        'sizeLimit' => 1024 * 1024,
        'providerOptions' => [
            'baseUrl' => $env('CDN_URL') . '/media',
            's3Options' => [
                'region' => $env('AWS_REGION', 'eu-west-1'),
                'forcePathStyle' => $env->bool('S3_PATH_STYLE', false),
                'params' => ['Bucket' => $env('AWS_BUCKET')],
            ],
        ],
    ]],
    'email' => ['config' => ['provider' => 'nodemailer', 'providerOptions' => ['port' => $env->int('SMTP_PORT', 587)]]],
];
`,
    );
    expect(await readStrapiPluginsConfig(dir, capture)).toEqual({ ok: true, config: EXPECTED });
  });

  it("reads a Strapi project's config/plugins.ts", async () => {
    const dir = await project(
      "plugins.ts",
      `export default ({ env }: { env: any }) => ({
  upload: { config: {
    provider: "aws-s3",
    sizeLimit: 1024 * 1024,
    providerOptions: {
      baseUrl: \`\${env("CDN_URL")}/media\`,
      s3Options: {
        region: env("AWS_REGION", "eu-west-1"),
        forcePathStyle: env.bool("S3_PATH_STYLE", false),
        params: { Bucket: env("AWS_BUCKET") },
      },
    },
  } },
  email: { config: { provider: "nodemailer", providerOptions: { port: env.int("SMTP_PORT", 587) } } },
});
`,
    );
    expect(await readStrapiPluginsConfig(dir, capture)).toEqual({ ok: true, config: EXPECTED });
  });

  it("reads a CommonJS config/plugins.js", async () => {
    const dir = await project(
      "plugins.js",
      `module.exports = ({ env }) => ({ email: { config: { provider: "sendmail", settings: { defaultFrom: env("FROM") } } } });\n`,
    );
    expect(await readStrapiPluginsConfig(dir, capture)).toEqual({
      ok: true,
      config: { email: { config: { provider: "sendmail", settings: { defaultFrom: { env: "FROM" } } } } },
    });
  });

  it("reports a config it cannot run, naming the file", async () => {
    const dir = await project("plugins.js", "module.exports = () => { throw new Error('boom'); };\n");
    const read = await readStrapiPluginsConfig(dir, capture);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.message).toContain("config/plugins.js");
  });
});

describe("readStrapiConfig", () => {
  it("reads any config file by name, config/api among them", async () => {
    const dir = await project("api.js", "module.exports = { rest: { defaultLimit: 10 } };\n");
    expect(await readStrapiConfig(dir, "api", capture)).toEqual({
      ok: true,
      config: { rest: { defaultLimit: 10 } },
    });
  });
});
