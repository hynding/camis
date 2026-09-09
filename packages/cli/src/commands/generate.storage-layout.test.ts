import { describe, expect, it, vi } from "vitest";
import type { GenerateAdapter, GenerateOptions, GenerationResult } from "@camis/adapter-kernel";
import type { Io } from "../io";

// Captures the exact GenerateOptions handed to the adapter so we can assert storageLayout
// flows from camis.config.json → loadConfig → generateCommand → adapter.generate untouched.
const seenOptions: GenerateOptions[] = [];
const emptyResult: GenerationResult = {
  files: [],
  manifest: { generator: "test", files: [] },
  gaps: { target: "filament", gaps: [] },
};
const fakeAdapter: GenerateAdapter = {
  target: "filament",
  generate: (_ir, options) => {
    seenOptions.push(options);
    return emptyResult;
  },
};

vi.mock("../registry", () => ({
  adapterFor: () => fakeAdapter,
}));

const { generateCommand } = await import("./generate");

const ir = JSON.stringify({
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
});

const makeIo = (config: string): Io => ({
  readFile: (p) => Promise.resolve(p.endsWith("camis.config.json") ? config : ir),
  writeFile: () => Promise.resolve(),
  materialize: () => Promise.resolve(),
  copyDir: () => Promise.resolve(),
  exec: () => Promise.resolve(0),
  out: () => {},
  cwd: "/p",
});

describe("generateCommand — storageLayout pass-through", () => {
  it("passes storageLayout through to the adapter alongside apiStyle", async () => {
    seenOptions.length = 0;
    const config = JSON.stringify({
      ir: "./camis.json",
      targets: [
        {
          target: "filament",
          out: "./out/admin",
          apiStyle: "strapi",
          storageLayout: "strapi",
        },
      ],
    });
    const code = await generateCommand("camis.config.json", makeIo(config), { write: false });
    expect(code).toBe(0);
    expect(seenOptions[0]?.storageLayout).toBe("strapi");
    expect(seenOptions[0]?.apiStyle).toBe("strapi");
  });

  it("omits storageLayout when the target does not configure it", async () => {
    seenOptions.length = 0;
    const config = JSON.stringify({
      ir: "./camis.json",
      targets: [{ target: "filament", out: "./out/admin" }],
    });
    const code = await generateCommand("camis.config.json", makeIo(config), { write: false });
    expect(code).toBe(0);
    expect(seenOptions[0]?.storageLayout).toBeUndefined();
    expect(seenOptions[0] && "storageLayout" in seenOptions[0]).toBe(false);
  });
});
