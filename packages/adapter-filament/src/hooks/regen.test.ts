import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../generate";
import { hooksBundle } from "../__fixtures__/hooks";

describe("filament hook regen preservation", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("regen preserves the hand-edited seed stub but rewrites the contract", async () => {
    dir = await mkdtemp(join(tmpdir(), "hook-regen-"));
    const gen = (): ReturnType<typeof filamentAdapter.generate> =>
      filamentAdapter.generate(hooksBundle, { projectName: "blog" });
    await materialize(gen(), dir);
    const stubPath = join(dir, "app/Hooks/TransformTitle.php");
    const contractPath = join(dir, "app/Hooks/Contracts/TransformTitleHook.php");
    await writeFile(stubPath, "<?php // HAND EDITED — must survive regen\n");
    await writeFile(contractPath, "// clobbered\n");
    await materialize(gen(), dir);
    expect(await readFile(stubPath, "utf8")).toContain("HAND EDITED");
    expect(await readFile(contractPath, "utf8")).toContain("@camis:generated");
  });
});
