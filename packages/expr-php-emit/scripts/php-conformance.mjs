// Emits PHP for every vector, runs each with the PHP runtime, compares value-based to expect.
// Runs ONLY in the gated CI job (needs PHP). Not run in the dev sandbox.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectors } from "@camis/expr";
import { emitPhp, PHP_RUNTIME } from "@camis/expr-php-emit";

const dir = await mkdtemp(join(tmpdir(), "ring1-php-"));
let failures = 0;
try {
  const runtimePath = join(dir, "Ring1.php");
  await writeFile(runtimePath, PHP_RUNTIME);
  for (const v of vectors) {
    const php = `<?php require '${runtimePath}'; $data = json_decode('${JSON.stringify(v.data)}', true); echo json_encode(${emitPhp(v.expr)});`;
    const file = join(dir, "vec.php");
    await writeFile(file, php);
    const out = execFileSync("php", [file], { encoding: "utf8" });
    const got = JSON.parse(out);
    if (JSON.stringify(got) !== JSON.stringify(v.expect)) {
      failures++;
      console.error(`FAIL ${v.name}: got ${JSON.stringify(got)} want ${JSON.stringify(v.expect)}`);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
if (failures > 0) { console.error(`${failures} PHP conformance failures`); process.exit(1); }
console.log(`PHP conformance PASS (${vectors.length} vectors)`);
