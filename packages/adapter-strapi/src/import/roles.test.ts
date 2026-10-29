import type { IrDocument } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import type { ArchivedEntity, ArchivedLink, StrapiArchive } from "./archive";
import { importStrapiRoles } from "./roles";

// Records as strapi-php's `strapi export` writes them (the archive in
// packages/adapter-filament/src/strapi-api/__fixtures__/transfer, whose roles the CLI test imports
// whole): a role, its permissions, and a link from each permission to its role.
const roleEntity = (id: number, type: string, description: string): ArchivedEntity => ({
  type: "plugin::users-permissions.role",
  id,
  data: { name: type, description, type },
});

const archiveOf = (
  roles: { id: number; type: string; actions: string[] }[],
  defaultRole?: string,
): StrapiArchive => {
  const entities: ArchivedEntity[] = [];
  const links: ArchivedLink[] = [];
  let permission = 0;
  for (const role of roles) {
    entities.push(roleEntity(role.id, role.type, `The ${role.type} role.`));
    role.actions.forEach((action, pos) => {
      permission++;
      entities.push({
        type: "plugin::users-permissions.permission",
        id: permission,
        data: { action },
      });
      links.push({
        kind: "relation.basic",
        relation: "manyToOne",
        left: { type: "plugin::users-permissions.permission", field: "role", ref: permission },
        right: {
          type: "plugin::users-permissions.role",
          field: "permissions",
          ref: role.id,
          pos: pos + 1,
        },
      });
    });
  }
  const configuration =
    defaultRole === undefined
      ? []
      : [
          {
            type: "core-store",
            value: {
              key: "plugin_users-permissions_advanced",
              value: { unique_email: true, default_role: defaultRole },
            },
          },
        ];
  return { entities, links, configuration };
};

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Book", kind: "collection", fields: [{ type: "string", name: "title" }] },
    {
      name: "Post",
      kind: "collection",
      options: { draftPublish: true },
      fields: [{ type: "string", name: "title" }],
    },
    { name: "Homepage", kind: "single", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

const AUTH = [
  "plugin::users-permissions.auth.callback",
  "plugin::users-permissions.auth.register",
  "plugin::users-permissions.user.me",
  "plugin::i18n.locales.listLocales",
];

describe("importStrapiRoles", () => {
  it("turns each role's Content API actions into the IR's grants", () => {
    const result = importStrapiRoles(
      archiveOf(
        [
          {
            id: 1,
            type: "authenticated",
            actions: [
              ...AUTH,
              "api::book.book.find",
              "api::book.book.findOne",
              "api::book.book.create",
              "api::book.book.update",
              "api::book.book.delete",
              "api::homepage.homepage.find",
              "api::homepage.homepage.update",
            ],
          },
          {
            id: 2,
            type: "public",
            actions: [...AUTH, "api::book.book.find", "api::book.book.findOne"],
          },
        ],
        "authenticated",
      ),
      doc,
    );
    expect(result.roles).toEqual({
      defaultRole: "authenticated",
      roles: [
        {
          name: "public",
          description: "The public role.",
          grants: [{ contentType: "Book", actions: ["read"] }],
        },
        {
          name: "authenticated",
          description: "The authenticated role.",
          grants: [
            { contentType: "Book", actions: ["create", "read", "update", "delete"] },
            { contentType: "Homepage", actions: ["read", "update"] },
          ],
        },
      ],
    });
    expect(result.gaps).toEqual([]);
    expect(result.document).toEqual(doc);
  });

  it("lets a role that writes a draft-and-publish type publish it, as a Strapi write's status does", () => {
    const result = importStrapiRoles(
      archiveOf([{ id: 1, type: "editor", actions: ["api::post.post.update"] }]),
      doc,
    );
    expect(result.roles.roles[0]?.grants).toEqual([
      { contentType: "Post", actions: ["update", "publish"] },
    ]);
  });

  it("grants nothing Strapi did not: half of a read is reported, not widened", () => {
    const result = importStrapiRoles(
      archiveOf([{ id: 1, type: "public", actions: ["api::book.book.find"] }]),
      doc,
    );
    expect(result.roles.roles[0]?.grants).toEqual([]);
    expect(result.gaps).toEqual([
      {
        feature: "strapiPermission",
        location: { contentType: "Book", rule: "public" },
        severity: "downgrade",
        message:
          'role "public": api::book.book.find: a camis grant on Book stands for create = create, read = find + findOne, update = update, delete = delete, so a role holding only part of one is not granted it',
      },
    ]);
  });

  it("reports an action on a type or plugin route the project lacks", () => {
    const result = importStrapiRoles(
      archiveOf([
        {
          id: 1,
          type: "authenticated",
          actions: ["api::magazine.magazine.find", "plugin::email.email.send"],
        },
      ]),
      doc,
    );
    expect(result.roles.roles[0]?.grants).toEqual([]);
    expect(result.gaps.map((g) => g.message)).toEqual([
      'role "authenticated": api::magazine.magazine.find: this project has no such type or plugin route, so it is not granted',
      'role "authenticated": plugin::email.email.send: this project has no such type or plugin route, so it is not granted',
    ]);
  });

  it("adds the builtin file and user types the media library's and the users' actions grant", () => {
    const result = importStrapiRoles(
      archiveOf([
        {
          id: 1,
          type: "authenticated",
          actions: [
            "plugin::upload.content-api.find",
            "plugin::upload.content-api.findOne",
            "plugin::upload.content-api.upload",
            "plugin::upload.content-api.destroy",
            "plugin::users-permissions.user.find",
            "plugin::users-permissions.user.findOne",
            "plugin::users-permissions.user.count",
          ],
        },
      ]),
      doc,
    );
    expect(result.roles.roles[0]?.grants).toEqual([
      { contentType: "File", actions: ["create", "read", "update", "delete"] },
      { contentType: "User", actions: ["read"] },
    ]);
    expect(result.document.contentTypes.map((ct) => [ct.name, ct.builtin])).toEqual([
      ["Book", undefined],
      ["Post", undefined],
      ["Homepage", undefined],
      ["File", "file"],
      ["User", "user"],
    ]);
  });

  it("leaves the default role out when the archive's is not among its roles", () => {
    const result = importStrapiRoles(
      archiveOf([{ id: 1, type: "public", actions: [] }], "ghost"),
      doc,
    );
    expect(result.roles).toEqual({
      roles: [{ name: "public", description: "The public role.", grants: [] }],
    });
  });
});
