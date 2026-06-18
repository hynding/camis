// Materializes the Filament overlay (content + relations + permissions) into an already-scaffolded
// Laravel app dir (argv[2]). Runs only in the gated adapter-filament-boot job; not in unit tests.
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { bootBundle } from "../src/__fixtures__/boot";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir>");
  process.exit(1);
}
await materialize(filamentAdapter.generate(bootBundle, { projectName: "blog" }), dest);
console.log(`overlay materialized into ${dest}`);
