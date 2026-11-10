// Materializes the Filament overlay (content + relations + permissions) into an already-scaffolded
// Laravel app dir (argv[2]). Runs only in the gated adapter-filament-boot job; not in unit tests.
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { bootBundle } from "../src/__fixtures__/boot";
import { authorRoleBundle } from "../src/strapi-api/__fixtures__/author-role";
import { strapiApiBundle } from "../src/strapi-api/__fixtures__/strapi-api";
import { storageBundle } from "../src/strapi-api/storage/__fixtures__/storage";

const [dest, ...flags] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
};
const style = flag("--style");
const storage = flag("--storage");
// A fixture of its own for the Strapi API style, in place of the strapi-api one.
const bundle = flag("--bundle");
if (
  !dest ||
  (storage !== undefined && style !== "strapi") ||
  (bundle !== undefined &&
    (bundle !== "author-role" || style !== "strapi" || storage !== undefined))
) {
  console.error(
    "usage: tsx scripts/overlay.ts <laravel-app-dir> [--style strapi [--storage strapi | --bundle author-role]]",
  );
  process.exit(1);
}
const result =
  storage === "strapi"
    ? filamentAdapter.generate(storageBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        storageLayout: "strapi",
      })
    : bundle === "author-role"
      ? filamentAdapter.generate(authorRoleBundle, { projectName: "press", apiStyle: "strapi" })
      : style === "strapi"
        ? filamentAdapter.generate(strapiApiBundle, {
            projectName: "oyl",
            apiStyle: "strapi",
            graphql: true,
            documentation: true,
          })
        : filamentAdapter.generate(bootBundle, { projectName: "blog" });
await materialize(result, dest);
const described = [
  style && `apiStyle ${style}`,
  storage && `storageLayout ${storage}`,
  bundle && `bundle ${bundle}`,
].filter(Boolean);
console.log(
  `overlay materialized into ${dest}${described.length ? ` (${described.join(", ")})` : ""}`,
);
