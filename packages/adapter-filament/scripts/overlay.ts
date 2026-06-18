// Materializes the Filament overlay into an already-scaffolded Laravel app dir (argv[2]).
// Runs only in the gated adapter-filament-boot job (needs a scaffolded app); not in unit tests.
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir>");
  process.exit(1);
}
await materialize(filamentAdapter.generate(blog, { projectName: "blog" }), dest);
console.log(`overlay materialized into ${dest}`);
