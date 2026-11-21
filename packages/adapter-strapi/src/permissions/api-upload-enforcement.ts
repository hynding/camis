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
// by its id. Once a role the rules restrict writes files, the generated upload extension decides
// each of those on the entries it changes, and the entry controllers check each file linked.

/** A type's or component's media fields, and its attributes that hold one further down. */
export interface ApiMediaHolder {
  fields: string[];
  nested: Record<string, { component: string } | { zone: string[] }>;
}

export interface ApiUploads {
  admins: string[];
  /** Every content type and component with a media field at some depth, by uid. */
  holders: Record<string, ApiMediaHolder>;
  /** Each content type with a media field: the roles holding read and update on it outright. */
  grants: Record<string, { read: string[]; update: string[] }>;
}

export interface UploadEnforcement {
  /** Null when no role the rules restrict writes files: the upload API is left as Strapi has it. */
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
 * A single type with a media field that a restricted role writes: Strapi's own single type
 * controller serves the write, and links any stored file id it names.
 */
const singleGap = (role: Role, ct: ContentType, fields: string[]): CapabilityGap => ({
  feature: "apiRelationReach",
  location: { contentType: ct.name, rule: role.name },
  severity: "error",
  message: `role "${role.name}" may ${holds(role, ct.name, ["update"]) ? "update" : "create"} single type "${ct.name}", whose media field ${fields.join(", ")} Strapi's own single type controller links to any stored file id: the upload API's rule (a file the caller uploaded, or one on an entry it may read) does not hold there`,
});

/** The media fields of a type, its own or an embedded component's, as `Type.field`. */
const mediaFieldNames = (doc: IrDocument, ct: ContentType): string[] => [
  ...ct.fields.filter((f) => f.type === "media").map((f) => `${ct.name}.${f.name}`),
  ...embedded(doc, ct.fields).flatMap((c) =>
    c.fields.filter((f) => f.type === "media").map((f) => `${c.name}.${f.name}`),
  ),
];

/** What the upload checks need, the types they make camis serve, and where they cannot hold. */
export const projectUploads = (doc: IrDocument, roles: readonly Role[]): UploadEnforcement => {
  const file = doc.contentTypes.find((ct) => ct.builtin === "file");
  const restricted = roles.filter(restricts);
  const writers = restricted.filter(
    (r) => file !== undefined && holds(r, file.name, ["create", "update", "delete"]),
  );
  if (writers.length === 0) return { uploads: null, served: new Set(), gaps: [] };
  const holding = mediaComponents(doc);
  const types = doc.contentTypes
    .filter((ct) => ct.builtin === undefined)
    .flatMap((ct) => {
      const holder = holderOf(ct.fields, holding);
      return holder === null ? [] : [{ ct, holder }];
    });
  const roleNames = (ct: ContentType, action: Action): string[] =>
    restricted
      .filter((r) => holds(r, ct.name, [action], true))
      .map((r) => r.name)
      .sort(codePointOrder);
  const openWrites = (ct: ContentType): boolean =>
    (ct.options?.publicApiActions ?? []).some((a) => a === "create" || a === "update");
  const gaps = types
    .filter(({ ct }) => ct.kind === "single")
    .flatMap(({ ct }) =>
      restricted
        .filter((r) => writes(r, ct))
        .map((r) => singleGap(r, ct, mediaFieldNames(doc, ct))),
    );
  return {
    uploads: {
      admins: roles
        .filter((r) => !restricts(r))
        .map((r) => r.name)
        .sort(codePointOrder),
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
    served: new Set(
      types
        .filter(
          ({ ct }) =>
            ct.kind === "collection" && (restricted.some((r) => writes(r, ct)) || openWrites(ct)),
        )
        .map(({ ct }) => ct.name),
    ),
    gaps,
  };
};
