import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../generate";
import { hooksDoc } from "../__fixtures__/hooks";

describe("strapi hook regen preservation", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("regen preserves the hand-edited seed stub but rewrites the contract", async () => {
    dir = await mkdtemp(join(tmpdir(), "hook-regen-"));
    const gen = (): ReturnType<typeof strapiAdapter.generate> =>
      strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" });
    await materialize(gen(), dir);
    const stubPath = join(dir, "src/hooks/transform-title.ts");
    const contractPath = join(dir, "src/hooks/contracts/transform-title.contract.ts");
    await writeFile(stubPath, "// HAND EDITED — must survive regen\n");
    await writeFile(contractPath, "// clobbered\n");
    await materialize(gen(), dir); // regenerate over the same dir
    expect(await readFile(stubPath, "utf8")).toContain("HAND EDITED"); // seed preserved
    expect(await readFile(contractPath, "utf8")).toContain("@camis:generated"); // overwrite regenerated
  });
});
