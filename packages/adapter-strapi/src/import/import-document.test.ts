import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { importDocument } from "./import-document";

const blog = {
  version: 1 as const,
  contentTypes: [
    {
      name: "Article",
      kind: "collection" as const,
      fields: [
        { type: "string" as const, name: "title", required: true },
        {
          type: "relation" as const,
          name: "author",
          relationKind: "manyToOne" as const,
          target: "Author",
          inverse: "articles",
        },
        { type: "component" as const, name: "seo", component: "SeoMeta", repeatable: false },
      ],
    },
    {
      name: "Author",
      kind: "collection" as const,
      fields: [{ type: "string" as const, name: "name" }],
    },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string" as const, name: "metaTitle" }] }],
};

describe("importDocument", () => {
  it("reads only declarative schema files and reconstructs IR", () => {
    const files = strapiAdapter.generate(
      { document: blog, roles: [] },
      { projectName: "blog" },
    ).files;
    const { document, gaps } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name).sort()).toEqual(["Article", "Author"]);
    expect(document.value.components.map((c) => c.name)).toEqual(["SeoMeta"]);
    const author = document.value.contentTypes.find((c) => c.name === "Author")!;
    expect(author.fields.map((f) => f.name)).toEqual(["name"]);
    expect(gaps.gaps).toEqual([]);
  });

  it("ignores generated .ts and skeleton files", () => {
    const files = [
      { path: "package.json", content: "{}" },
      { path: "src/api/article/controllers/article.ts", content: "x" },
      {
        path: "src/api/article/content-types/article/schema.json",
        content: JSON.stringify({
          kind: "collectionType",
          collectionName: "articles",
          info: { singularName: "article", pluralName: "articles", displayName: "Article" },
          options: {},
          pluginOptions: {},
          attributes: { title: { type: "string" } },
        }),
      },
    ];
    const { document } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes).toHaveLength(1);
  });

  it("reports an unsupported attribute as a gap, not a field", () => {
    const files = [
      {
        path: "src/api/article/content-types/article/schema.json",
        content: JSON.stringify({
          kind: "collectionType",
          collectionName: "articles",
          info: { singularName: "article", pluralName: "articles", displayName: "Article" },
          options: {},
          pluginOptions: {},
          attributes: {
            title: { type: "string" },
            secret: { type: "password" },
          },
        }),
      },
    ];
    const { document, gaps } = importDocument(files);
    expect(gaps.gaps.some((g) => g.feature === "password")).toBe(true);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title"]);
  });
});

it("imports a blocks attribute as a blocks field", () => {
  const files = [
    {
      path: "src/api/article/content-types/article/schema.json",
      content: JSON.stringify({
        kind: "collectionType",
        collectionName: "articles",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        options: {},
        pluginOptions: {},
        attributes: { body: { type: "blocks", required: true } },
      }),
    },
  ];
  const { document, gaps } = importDocument(files);
  expect(gaps.gaps).toEqual([]);
  expect(document.ok).toBe(true);
  if (!document.ok) return;
  expect(document.value.contentTypes[0]!.fields).toEqual([
    { type: "blocks", name: "body", required: true },
  ]);
});

describe("importDocument — builtin user synthesis", () => {
  const noteWithPluginOwner = {
    path: "src/api/note/content-types/note/schema.json",
    content: JSON.stringify({
      kind: "collectionType",
      collectionName: "notes",
      info: { singularName: "note", pluralName: "notes", displayName: "Note" },
      options: {},
      pluginOptions: {},
      attributes: {
        text: { type: "text" },
        owner: {
          type: "relation",
          relation: "manyToOne",
          target: "plugin::users-permissions.user",
        },
      },
    }),
  };

  it("synthesizes a builtin User content type when plugin user relations are imported", () => {
    const { document, gaps } = importDocument([noteWithPluginOwner]);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    const user = document.value.contentTypes.find((ct) => ct.name === "User");
    expect(user?.builtin).toBe("user");
    expect(gaps.gaps).toEqual([]);
  });

  it("does not synthesize User when the project defines api::user.user itself", () => {
    const ownUser = {
      path: "src/api/user/content-types/user/schema.json",
      content: JSON.stringify({
        kind: "collectionType",
        collectionName: "users",
        info: { singularName: "user", pluralName: "users", displayName: "User" },
        options: {},
        pluginOptions: {},
        attributes: { username: { type: "string" } },
      }),
    };
    const { document } = importDocument([noteWithPluginOwner, ownUser]);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    const users = document.value.contentTypes.filter((ct) => ct.name === "User");
    expect(users).toHaveLength(1);
    expect(users[0]?.builtin).toBeUndefined();
    expect(users[0]?.fields.map((f) => f.name)).toEqual(["username"]);
  });
});

describe("importDocument — component names", () => {
  it("imports component group and collectionName into names", () => {
    const r = importDocument([
      {
        path: "src/components/finance/money.json",
        content: JSON.stringify({
          collectionName: "components_finance_money",
          info: { displayName: "Money" },
          attributes: { minor: { type: "biginteger" }, currency: { type: "string" } },
        }),
      },
    ]).document;
    expect(r.ok && r.value.components[0]?.names).toEqual({
      collection: "components_finance_money",
      group: "finance",
    });
  });
});

describe("importDocument upsertBy", () => {
  const note = JSON.stringify({
    kind: "collectionType",
    collectionName: "notes",
    info: { singularName: "note", pluralName: "notes", displayName: "Note" },
    attributes: {
      recordId: { type: "string", required: true, unique: true },
      text: { type: "text" },
    },
  });
  const tag = JSON.stringify({
    kind: "collectionType",
    collectionName: "tags",
    info: { singularName: "tag", pluralName: "tags", displayName: "Tag" },
    attributes: { label: { type: "string" } },
  });
  const files = [
    { path: "src/api/note/content-types/note/schema.json", content: note },
    { path: "src/api/tag/content-types/tag/schema.json", content: tag },
  ];
  it("sets options.upsertBy only on types that have that unique field", () => {
    const r = importDocument(files, { upsertBy: "recordId" }).document;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = new Map(r.value.contentTypes.map((c) => [c.name, c]));
    expect(byName.get("Note")?.options?.upsertBy).toBe("recordId");
    expect(byName.get("Tag")?.options?.upsertBy).toBeUndefined();
  });
  it("leaves options untouched without the option", () => {
    const r = importDocument(files).document;
    expect(r.ok && r.value.contentTypes[0]?.options?.upsertBy).toBeUndefined();
  });
});
