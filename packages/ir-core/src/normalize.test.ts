import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { normalize } from "./normalize";

const base: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "BlogPost", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

describe("normalize", () => {
  it("derives names when absent", () => {
    const ct = normalize(base).contentTypes[0]!;
    expect(ct.names).toMatchObject({
      display: "Blog Post",
      plural: "BlogPosts",
      collection: "blog_posts",
    });
  });

  it("keeps explicit name overrides", () => {
    const doc: IrDocument = {
      ...base,
      contentTypes: [{ ...base.contentTypes[0]!, names: { collection: "posts" } }],
    };
    expect(normalize(doc).contentTypes[0]!.names!.collection).toBe("posts");
  });

  it("fills option defaults", () => {
    expect(normalize(base).contentTypes[0]!.options).toEqual({
      draftPublish: false,
      timestamps: true,
      softDelete: false,
    });
  });

  it("preserves field order", () => {
    const doc: IrDocument = {
      ...base,
      contentTypes: [
        {
          name: "X",
          kind: "collection",
          fields: [
            { type: "string", name: "b" },
            { type: "string", name: "a" },
          ],
        },
      ],
    };
    expect(normalize(doc).contentTypes[0]!.fields.map((f) => f.name)).toEqual(["b", "a"]);
  });

  it("is idempotent", () => {
    const once = normalize(base);
    expect(normalize(once)).toEqual(once);
  });
});
