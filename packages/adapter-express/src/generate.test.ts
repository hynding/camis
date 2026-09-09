import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter, expressAdapterFor } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "component", name: "seo", component: "Seo", repeatable: false } as never,
        ],
      },
    ],
    components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
  },
  roles: [],
};

describe("expressAdapter", () => {
  const result = expressAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the skeleton + schema + routes", () => {
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/db/schema.ts");
    expect(paths).toContain("src/routes/articles.ts");
    expect(paths).toContain("src/server.ts");
  });
  it("builds a manifest and flattens the component field into embedded columns", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps.gaps).toEqual([]);
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    expect(schema).toContain("seo_meta_title: text('seo_meta_title'),");
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});

describe("secured generation", () => {
  it("with no roles, output matches 8B (no auth/permissions files)", () => {
    const r = expressAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [{ type: "string", name: "title", required: true }],
            },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    expect(r.files.some((f) => f.path.startsWith("src/auth/"))).toBe(false);
    expect(r.files.some((f) => f.path === "src/permissions/enforce.ts")).toBe(false);
  });
  it("with roles, emits auth + permissions + ring1 + secured routes and merges gaps", () => {
    const bundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "string", name: "title", required: true },
              { type: "string", name: "secretNotes" },
            ],
          },
        ],
        components: [],
      },
      roles: [
        {
          name: "Editor",
          grants: [
            {
              contentType: "Article",
              actions: ["read", "update"],
              condition: {
                kind: "eq",
                left: { kind: "var", name: "record.title" },
                right: { kind: "lit", value: "x" },
              },
              fieldRules: [{ field: "secretNotes", access: "read" }],
            },
          ],
        },
      ],
    } as never;
    const r = expressAdapter.generate(bundle, { projectName: "blog" });
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("src/auth/store.ts");
    expect(paths).toContain("src/auth/verify.ts");
    expect(paths).toContain("src/ring1/runtime.ts");
    expect(paths).toContain("src/permissions/conditions.ts");
    expect(paths).toContain("src/permissions/enforce.ts");
    expect(r.files.find((f) => f.path === "src/routes/articles.ts")!.content).toContain(
      "authorizeAction",
    );
    expect(r.files.find((f) => f.path === "src/permissions/conditions.ts")!.content).toContain(
      "c__Editor__Article__record",
    );
  });
});

describe("admin sub-app emission", () => {
  it("emits the admin sub-app only when the bundle carries roles", () => {
    const bare = expressAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [{ type: "string", name: "title", required: true }],
            },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    expect(bare.files.some((f) => f.path.startsWith("admin/"))).toBe(false);

    const secured = expressAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [{ type: "string", name: "title", required: true }],
            },
          ],
          components: [],
        },
        roles: [{ name: "Editor", grants: [{ contentType: "Article", actions: ["read"] }] }],
      } as never,
      { projectName: "blog" },
    );
    const paths = secured.files.map((f) => f.path);
    expect(paths).toContain("admin/package.json");
    expect(paths).toContain("admin/src/App.tsx");
    expect(paths).toContain("admin/src/dataProvider.ts");
    expect(paths).toContain("admin/src/resources/articles.tsx");
  });
});

describe("AI emission", () => {
  it("emits AI provider + populate and AI-aware routes when a field has an ai annotation", () => {
    const bundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "text", name: "body" },
              {
                type: "text",
                name: "summary",
                ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
              },
            ],
          },
        ],
        components: [],
      },
      roles: [],
    } as never;
    const r = expressAdapter.generate(bundle, { projectName: "blog" });
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("src/ai/provider.ts");
    expect(paths).toContain("src/ai/populate.ts");
    expect(r.files.find((f) => f.path === "src/routes/articles.ts")!.content).toContain(
      "populateAiFields",
    );
  });
  it("emits no AI files when no field has an ai annotation", () => {
    const r = expressAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            { name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    expect(r.files.some((f) => f.path.startsWith("src/ai/"))).toBe(false);
  });
});

describe("expressAdapterFor", () => {
  const relBundle = {
    document: {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "string", name: "title", required: true },
            {
              type: "relation",
              name: "author",
              relationKind: "manyToOne",
              target: "Author",
              inverse: "articles",
            },
            { type: "component", name: "seo", component: "Seo", repeatable: false },
          ],
        },
        {
          name: "Author",
          kind: "collection",
          fields: [{ type: "string", name: "name", required: true }],
        },
      ],
      components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
    },
    roles: [],
  } as never;

  it("default export targets sqlite", () => {
    expect(expressAdapter.target).toBe("express");
  });
  it("pg adapter emits a pg schema + camis.schema.json + relation FK + embedded component", () => {
    const result = expressAdapterFor("pgsql").generate(relBundle, { projectName: "blog" });
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    expect(schema).toContain("pgTable(");
    expect(schema).toContain("author_id: integer('author_id').references(() => authors.id)");
    expect(schema).toContain("seo_meta_title: varchar('seo_meta_title', { length: 255 }),");
    expect(result.files.some((f) => f.path === "camis.schema.json")).toBe(true);
    expect(result.gaps.gaps.some((g) => g.feature === "component")).toBe(false);
  });
});

describe("component fields", () => {
  const doc = {
    version: 1 as const,
    contentTypes: [
      {
        name: "Transaction",
        kind: "collection" as const,
        fields: [
          { type: "string" as const, name: "category" },
          { type: "component" as const, name: "amount", component: "Money", repeatable: false },
        ],
      },
      {
        name: "ActivitySession",
        kind: "collection" as const,
        fields: [
          { type: "dateTime" as const, name: "occurredAt" },
          {
            type: "component" as const,
            name: "quantities",
            component: "Quantity",
            repeatable: true,
          },
        ],
      },
    ],
    components: [
      {
        name: "Money",
        fields: [
          { type: "bigInteger" as const, name: "minor", required: true },
          { type: "string" as const, name: "currency", required: true },
        ],
      },
      {
        name: "Quantity",
        fields: [
          { type: "decimal" as const, name: "amount", required: true },
          { type: "string" as const, name: "unit", required: true },
        ],
      },
    ],
  };

  it("emits embedded columns and child tables with relations, and no component gaps", () => {
    const result = expressAdapterFor("sqlite").generate(
      { document: doc, roles: [] },
      { projectName: "t" },
    );
    expect(result.gaps.gaps).toEqual([]);
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    // `amount` is an optional component reference, so its inner required-ness cannot reach the
    // flattened columns — a record without an amount at all has to be storable.
    expect(schema).toContain("amount_minor: integer('amount_minor'),");
    expect(schema).toContain("amount_currency: text('amount_currency'),");
    // A repeatable's child-table row exists only when the item does, so NOT NULL still holds.
    expect(schema).toContain("amount: numeric('amount').notNull(),");
    expect(schema).toContain(
      'export const activity_sessions_quantities = sqliteTable("activity_sessions_quantities", {',
    );
    expect(schema).toContain(
      "activity_session_id: integer('activity_session_id').references(() => activity_sessions.id),",
    );
    expect(schema).toContain("quantities: many(activity_sessions_quantities),");
    expect(schema).toContain(
      "activity_session: one(activity_sessions, { fields: [activity_sessions_quantities.activity_session_id], references: [activity_sessions.id] }),",
    );
  });

  // A child-table row exists only when the repeatable item does, so a required scalar on the
  // item is a genuine NOT NULL — but an OPTIONAL sub-component reference inside the item may
  // still be absent, and the columns it flattens to are shared by the whole sub-component.
  it("keeps an optional sub-component's child-table columns nullable", () => {
    const orderDoc = {
      version: 1 as const,
      contentTypes: [
        {
          name: "Order",
          kind: "collection" as const,
          fields: [
            { type: "component" as const, name: "items", component: "LineItem", repeatable: true },
          ],
        },
      ],
      components: [
        {
          name: "LineItem",
          fields: [
            { type: "integer" as const, name: "qty", required: true },
            { type: "component" as const, name: "money", component: "Money", repeatable: false },
          ],
        },
        {
          name: "Money",
          fields: [
            { type: "bigInteger" as const, name: "minor", required: true },
            { type: "string" as const, name: "currency", required: true },
          ],
        },
      ],
    };
    const result = expressAdapterFor("sqlite").generate(
      { document: orderDoc, roles: [] },
      { projectName: "t" },
    );
    expect(result.gaps.gaps).toEqual([]);
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    expect(schema).toContain("qty: integer('qty').notNull(),");
    expect(schema).toContain("money_minor: integer('money_minor'),");
    expect(schema).toContain("money_currency: text('money_currency'),");
  });
});
