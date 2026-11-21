import {
  fieldApiName,
  type CapabilityGap,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";
import { componentUid, strapiNames } from "@camis/strapi-schema";
import { embedded } from "./api-reach";
import { codePointOrder } from "./code-point-order";

// The upload plugin attaches, replaces and deletes files on entries (`ref`, `refId` and `field` on
// POST /api/upload, `?id=`, DELETE /api/upload/files/:id), and any entry write links a stored file
// by its id, with no upload permission. Wherever a restricted caller writes a type with a media
// field, the entry controllers check each file linked; wherever the rules restrict anyone, the
// generated upload extension also decides each upload API request: a write on the entries it
// changes, a read on the populate (no file's related entries, which may be of any type).

/** A type's or component's media fields, and its attributes that hold one further down. */
export interface ApiMediaHolder {
  fields: string[];
  nested: Record<string, { component: string } | { zone: string[] }>;
}

export interface ApiUploads {
  admins: string[];
  /** A restricted role writes files: the upload extension records each file's uploader. */
  uploaderRecorded: boolean;
  /** Every content type and component with a media field at some depth, by uid. */
  holders: Record<string, ApiMediaHolder>;
  /** Each content type with a media field: the roles holding read and update on it outright. */
  grants: Record<string, { read: string[]; update: string[] }>;
}

export interface UploadEnforcement {
  /** Null where the rules restrict no one: no non-admin role and no open route. */
  uploads: ApiUploads | null;
  /** The collection types with a media field a restricted caller writes, which camis serves. */
  served: Set<string>;
  gaps: CapabilityGap[];
}

const restricts = (role: Role): boolean => role.admin !== true;

const holds = (role: Role, contentType: string, actions: readonly Action[], outright = false) =>
  role.grants.some(
    (g) =>
      g.contentType === contentType &&
      actions.some((a) => g.actions.includes(a)) &&
      (!outright || g.condition === undefined),
  );

/** The components holding a media field at some depth, by name. */
const mediaComponents = (doc: IrDocument): Map<string, Component> => {
  const byName = new Map(doc.components.map((c) => [c.name, c]));
  const holding = new Map<string, Component>();
  const holdsMedia = (fields: readonly Field[], seen: ReadonlySet<string>): boolean =>
    fields.some((f) => {
      if (f.type === "media") return true;
      const names =
        f.type === "component" ? [f.component] : f.type === "dynamicZone" ? f.components : [];
      return names.some((name) => {
        const c = byName.get(name);
        return c !== undefined && !seen.has(name) && holdsMedia(c.fields, new Set([...seen, name]));
      });
    });
  for (const c of doc.components)
    if (holdsMedia(c.fields, new Set([c.name]))) holding.set(c.name, c);
  return holding;
};

/** The holder entry of a field list: its media fields and the attributes leading to one. */
const holderOf = (
  fields: readonly Field[],
  holding: ReadonlyMap<string, Component>,
): ApiMediaHolder | null => {
  const media = fields.filter((f) => f.type === "media").map(fieldApiName);
  const nested: ApiMediaHolder["nested"] = {};
  for (const f of fields) {
    if (f.type === "component" && holding.has(f.component))
      nested[fieldApiName(f)] = { component: componentUid(holding.get(f.component)!) };
    if (f.type === "dynamicZone") {
      const zone = f.components
        .filter((c) => holding.has(c))
        .map((c) => componentUid(holding.get(c)!));
      if (zone.length > 0) nested[fieldApiName(f)] = { zone };
    }
  }
  return media.length === 0 && Object.keys(nested).length === 0
    ? null
    : { fields: media.sort(codePointOrder), nested };
};

const sorted = <T>(entries: [string, T][]): Record<string, T> =>
  Object.fromEntries(entries.sort(([a], [b]) => codePointOrder(a, b)));

const writes = (role: Role, ct: ContentType): boolean => holds(role, ct.name, ["create", "update"]);

/**
 * A single type with a media field that a restricted role (or an `auth: false` route) writes:
 * Strapi's own single type controller serves the write, and links any stored file id it names.
 */
const singleGap = (
  rule: string,
  who: string,
  verb: "create" | "update",
  ct: ContentType,
  fields: string[],
): CapabilityGap => ({
  feature: "apiRelationReach",
  location: { contentType: ct.name, rule },
  severity: "error",
  message: `${who} may ${verb} single type "${ct.name}", whose media field ${fields.join(", ")} Strapi's own single type controller links to any stored file id: the rule camis holds a media link to (a file the caller uploaded through the upload API, or one on an entry it may update) does not hold there`,
});

/** The media fields of a type, its own or an embedded component's, as `Type.field`. */
const mediaFieldNames = (doc: IrDocument, ct: ContentType): string[] => [
  ...ct.fields.filter((f) => f.type === "media").map((f) => `${ct.name}.${f.name}`),
  ...embedded(doc, ct.fields).flatMap((c) =>
    c.fields.filter((f) => f.type === "media").map((f) => `${c.name}.${f.name}`),
  ),
];

/**
 * What the media checks need, the types they make camis serve, and where they cannot hold. Strapi
 * links a stored file through a media field with no upload permission, so the checks run wherever
 * a restricted role (or an `auth: false` route) writes a type with one, file grants or not; a role
 * that writes files makes the upload extension record uploaders.
 */
export const projectUploads = (doc: IrDocument, roles: readonly Role[]): UploadEnforcement => {
  // A grant on any built-in file type of the IR is one on the media library.
  const files = doc.contentTypes.filter((ct) => ct.builtin === "file");
  const restricted = roles.filter(restricts);
  const writers = restricted.filter((r) =>
    files.some((file) => holds(r, file.name, ["create", "update", "delete"])),
  );
  const holding = mediaComponents(doc);
  const types = doc.contentTypes
    .filter((ct) => ct.builtin === undefined)
    .flatMap((ct) => {
      const holder = holderOf(ct.fields, holding);
      return holder === null ? [] : [{ ct, holder }];
    });
  const open = (ct: ContentType): ("create" | "update")[] =>
    (ct.options?.publicApiActions ?? []).filter(
      (a): a is "create" | "update" => a === "create" || a === "update",
    );
  const written = types.filter(
    ({ ct }) => restricted.some((r) => writes(r, ct)) || open(ct).length > 0,
  );
  // The upload API's find and findOne return a file's related entries, of any type, to a role that
  // reads files, and a custom API token may hold their scope, which generation cannot see: wherever
  // the rules restrict anyone (a non-admin role, an open route), the extension checks the one and
  // refuses the other.
  const guarded =
    restricted.length > 0 ||
    doc.contentTypes.some((ct) => (ct.options?.publicApiActions ?? []).length > 0);
  if (!guarded) return { uploads: null, served: new Set(), gaps: [] };
  const roleNames = (ct: ContentType, action: Action): string[] =>
    restricted
      .filter((r) => holds(r, ct.name, [action], true))
      .map((r) => r.name)
      .sort(codePointOrder);
  const gaps = written
    .filter(({ ct }) => ct.kind === "single")
    .flatMap(({ ct }) => {
      const fields = mediaFieldNames(doc, ct);
      const opened = open(ct);
      return [
        ...restricted
          .filter((r) => writes(r, ct))
          .map((r) =>
            singleGap(
              r.name,
              `role "${r.name}"`,
              holds(r, ct.name, ["update"]) ? "update" : "create",
              ct,
              fields,
            ),
          ),
        ...(opened.length === 0
          ? []
          : [
              singleGap(
                "public",
                "anyone (an auth: false route)",
                opened.includes("update") ? "update" : "create",
                ct,
                fields,
              ),
            ]),
      ];
    });
  return {
    uploads: {
      admins: roles
        .filter((r) => !restricts(r))
        .map((r) => r.name)
        .sort(codePointOrder),
      uploaderRecorded: writers.length > 0,
      holders: sorted([
        ...types.map(({ ct, holder }) => [strapiNames(ct).uid, holder] as [string, ApiMediaHolder]),
        ...[...holding.values()].flatMap((c): [string, ApiMediaHolder][] => {
          const holder = holderOf(c.fields, holding);
          return holder === null ? [] : [[componentUid(c), holder]];
        }),
      ]),
      grants: sorted(
        types.map(({ ct }) => [
          strapiNames(ct).uid,
          { read: roleNames(ct, "read"), update: roleNames(ct, "update") },
        ]),
      ),
    },
    served: new Set(written.filter(({ ct }) => ct.kind === "collection").map(({ ct }) => ct.name)),
    gaps,
  };
};
