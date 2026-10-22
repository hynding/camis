// Materializes the Filament overlay (content + relations + permissions) into an already-scaffolded
// Laravel app dir (argv[2]). Runs only in the gated adapter-filament-boot job; not in unit tests.
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { bootBundle } from "../src/__fixtures__/boot";
import { strapiApiBundle } from "../src/strapi-api/__fixtures__/strapi-api";

const dest = process.argv[2];
const style = process.argv[3] === "--style" ? process.argv[4] : undefined;
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir> [--style strapi]");
  process.exit(1);
}
const result =
  style === "strapi"
    ? filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        graphql: true,
      })
    : filamentAdapter.generate(bootBundle, { projectName: "blog" });
await materialize(result, dest);
console.log(`overlay materialized into ${dest}${style ? ` (apiStyle ${style})` : ""}`);
