import type { IrBundle } from "@camis/permissions";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// A runtime helper is emitted only where the project needs it, so a call into one the project
// does not ship is a fatal error the first time the code runs, which no golden file shows.
const plainBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Story",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "media", name: "cover" },
        ],
      },
    ],
    components: [],
  },
  roles: [{ name: "authenticated", grants: [{ contentType: "Story", actions: ["read"] }] }],
};

// Called only for a relation to a localized type, which a project without locales has none of.
const GUARDED = new Set(["StrapiLocales"]);

const supportCalls = (bundle: IrBundle): { missing: string[] } => {
  const files = filamentAdapter.generate(bundle, { projectName: "p", apiStyle: "strapi" }).files;
  const shipped = new Set(
    files.flatMap((f) =>
      [
        ...f.content.matchAll(
          /^(?:final |abstract |readonly )*(?:class|trait|enum|interface) (\w+)/gm,
        ),
      ].map((m) => m[1]!),
    ),
  );
  const missing = new Set<string>();
  for (const file of files.filter((f) => f.path.endsWith(".php"))) {
    for (const [, name] of file.content.matchAll(/\b(Strapi[A-Z]\w*)::/g)) {
      if (name !== undefined && !shipped.has(name) && !GUARDED.has(name))
        missing.add(`${name} (${file.path})`);
    }
  }
  return { missing: [...missing].sort() };
};

describe("runtime helpers", () => {
  it("ships every Strapi helper the fixture's code calls", () => {
    expect(supportCalls(strapiApiBundle)).toEqual({ missing: [] });
  });

  // Every content type here is without draft and publish, as each of sitlab's is.
  it("ships every Strapi helper a project without draft and publish calls", () => {
    expect(supportCalls(plainBundle)).toEqual({ missing: [] });
  });
});
