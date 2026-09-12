import { describe, expect, it } from "vitest";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { catalog } from "./__fixtures__/catalog";
import { migrationOrder } from "./migration-order";

const emittedOf = (doc: IrDocument): ContentType[] =>
  doc.contentTypes.filter((ct) => ct.builtin === undefined);

describe("migrationOrder", () => {
  it("orders the catalog fixture Author, Article, Tag (Article depends on Author)", () => {
    const emitted = emittedOf(catalog.document);
    const { order, gaps } = migrationOrder(catalog.document, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Author", "Article", "Tag"]);
    expect(gaps).toEqual([]);
  });

  it("keeps IR order when there are no relations", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
        { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
      ],
      components: [],
    };
    const emitted = emittedOf(doc);
    const { order, gaps } = migrationOrder(doc, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Article", "Tag"]);
    expect(gaps).toEqual([]);
  });

  it("places the oneToMany FK-holding target after the owner, even when it comes first in IR order", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Comment",
          kind: "collection",
          fields: [{ type: "string", name: "body" }],
        },
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "string", name: "title" },
            {
              type: "relation",
              name: "comments",
              relationKind: "oneToMany",
              target: "Comment",
              inverse: "article",
            },
          ],
        },
      ],
      components: [],
    };
    const emitted = emittedOf(doc);
    const { order, gaps } = migrationOrder(doc, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Article", "Comment"]);
    expect(gaps).toEqual([]);
  });

  it("keeps IR order and adds no gap for a self-reference", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Category",
          kind: "collection",
          fields: [
            { type: "string", name: "label" },
            {
              type: "relation",
              name: "parent",
              relationKind: "manyToOne",
              target: "Category",
            },
          ],
        },
      ],
      components: [],
    };
    const emitted = emittedOf(doc);
    const { order, gaps } = migrationOrder(doc, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Category"]);
    expect(gaps).toEqual([]);
  });

  it("gaps a two-type cycle through owning relations and appends both types in IR order", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "string", name: "title" },
            {
              type: "relation",
              name: "featuredComment",
              relationKind: "manyToOne",
              target: "Comment",
            },
          ],
        },
        {
          name: "Comment",
          kind: "collection",
          fields: [
            { type: "string", name: "body" },
            {
              type: "relation",
              name: "article",
              relationKind: "manyToOne",
              target: "Article",
            },
          ],
        },
      ],
      components: [],
    };
    const emitted = emittedOf(doc);
    const { order, gaps } = migrationOrder(doc, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Article", "Comment"]);
    expect(gaps).toEqual([
      {
        feature: "relationCycle",
        severity: "error",
        location: { contentType: "Article" },
        message:
          "content types Article, Comment reference each other through owning relations; " +
          "their migrations cannot be ordered — break the cycle or make one side a oneToMany " +
          "with an inverse",
      },
    ]);
  });

  it("ignores a relation to a type outside emitted (the builtin user type)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [
            { type: "string", name: "text" },
            {
              type: "relation",
              name: "owner",
              relationKind: "manyToOne",
              target: "User",
            },
          ],
        },
        {
          name: "User",
          kind: "collection",
          builtin: "user",
          fields: [{ type: "string", name: "username" }],
        },
      ],
      components: [],
    };
    const emitted = emittedOf(doc);
    const { order, gaps } = migrationOrder(doc, emitted);
    expect(order.map((ct) => ct.name)).toEqual(["Note"]);
    expect(gaps).toEqual([]);
  });
});
