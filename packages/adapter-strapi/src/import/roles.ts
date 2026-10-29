import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import { ACTIONS, type Action, type Grant, type Role, type RolesFile } from "@camis/permissions";
import { strapiNames } from "@camis/strapi-schema";
import {
  API_ACTION_SUFFIXES,
  FILE_API_ACTIONS,
  PLUGIN_USER_UID,
  USER_API_ACTIONS,
} from "../permissions/actions";
import type { StrapiArchive } from "./archive";
import { BUILTIN_USER } from "./import-document";

const ROLE_UID = "plugin::users-permissions.role";
const PERMISSION_UID = "plugin::users-permissions.permission";
const UPLOAD_API = "plugin::upload.content-api";

/**
 * Actions every camis target serves to every role, as Strapi grants them by default: signing in
 * and out, the caller's own account, and the locales list.
 */
const BUILT_IN =
  /^plugin::users-permissions\.auth\.|^plugin::users-permissions\.user\.me$|^plugin::i18n\.locales\.listLocales$/;

/** The media library a role's upload actions grant, when the document declares none. */
const BUILTIN_FILE: ContentType = { name: "File", kind: "collection", builtin: "file", fields: [] };

/** The users-permissions actions each camis action needs before it is granted, per subject. */
interface Subject {
  contentType: ContentType;
  prefix: string;
  actions: Partial<Record<Action, string[]>>;
}

const contentTypeActions = (ct: ContentType): Partial<Record<Action, string[]>> =>
  // A single type has one entry: Strapi finds, updates (or first makes) and deletes it.
  ct.kind === "single"
    ? { read: ["find"], update: ["update"], delete: ["delete"] }
    : API_ACTION_SUFFIXES;

const suffixes = (prefix: string, table: Record<Action, string[]>) =>
  Object.fromEntries(
    Object.entries(table).map(([action, uids]) => [
      action,
      uids.map((uid) => uid.slice(prefix.length + 1)),
    ]),
  ) as Partial<Record<Action, string[]>>;

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The role Strapi gives a new account (Advanced settings), if the archive holds its settings. */
const defaultRoleOf = (archive: StrapiArchive): string | undefined => {
  for (const entry of archive.configuration) {
    const store = record(entry.value);
    if (store.key !== "plugin_users-permissions_advanced") continue;
    const value =
      typeof store.value === "string" ? (JSON.parse(store.value) as unknown) : store.value;
    const role = textOf(record(value).default_role);
    if (role !== "") return role;
  }
  return undefined;
};

/** Public and authenticated first, as Strapi lists them; then the archive's own roles in order. */
const roleOrder = (type: string): number =>
  type === "public" ? 0 : type === "authenticated" ? 1 : 2;

export interface ImportedRoles {
  /** The document, with the builtin user or file type a role's grants needed added. */
  document: IrDocument;
  roles: RolesFile;
  gaps: CapabilityGap[];
}

/**
 * The IR's roles from the users-permissions roles and permissions a Strapi export holds: the
 * inverse of the users-permissions projection. A camis action is granted only when the role holds
 * every Strapi action it stands for, so an import never grants more than Strapi did; whatever
 * the IR cannot say is reported. Strapi publishes through a write's `status`, so a role that may
 * create or update a draft-and-publish type may publish it.
 */
export const importStrapiRoles = (archive: StrapiArchive, input: IrDocument): ImportedRoles => {
  const gaps: CapabilityGap[] = [];
  const contentTypes = [...input.contentTypes];
  const builtin = (kind: "user" | "file", fallback: ContentType): ContentType =>
    contentTypes.find((ct) => ct.builtin === kind) ?? fallback;

  const actionsById = new Map<string, string>();
  for (const e of archive.entities)
    if (e.type === PERMISSION_UID) actionsById.set(String(e.id), textOf(e.data.action));
  const granted = new Map<string, Set<string>>();
  for (const link of archive.links) {
    if (link.left.type !== PERMISSION_UID || link.left.field !== "role") continue;
    const action = actionsById.get(String(link.left.ref));
    if (action === undefined) continue;
    const role = String(link.right.ref);
    (granted.get(role) ?? granted.set(role, new Set()).get(role)!).add(action);
  }

  const archived = archive.entities
    .filter((e) => e.type === ROLE_UID)
    .map((e, index) => ({ e, index }))
    .sort(
      (a, b) =>
        roleOrder(textOf(a.e.data.type)) - roleOrder(textOf(b.e.data.type)) || a.index - b.index,
    );

  const roles = archived.map(({ e }): Role => {
    const name = textOf(e.data.type);
    const actions = granted.get(String(e.id)) ?? new Set<string>();
    const bySubject = new Map<string, Set<string>>();
    for (const action of actions) {
      if (BUILT_IN.test(action)) continue;
      const at = action.lastIndexOf(".");
      const prefix = action.slice(0, at);
      (bySubject.get(prefix) ?? bySubject.set(prefix, new Set()).get(prefix)!).add(
        action.slice(at + 1),
      );
    }
    const grants: Grant[] = [];
    for (const [prefix, held] of bySubject) {
      const subject = subjectOf(prefix, contentTypes, builtin);
      if (subject === undefined) {
        gaps.push(
          gap(
            name,
            `${[...held].map((a) => `${prefix}.${a}`).join(", ")}: this project has no such type or plugin route, so it is not granted`,
          ),
        );
        continue;
      }
      const given: Action[] = [];
      const used = new Set<string>();
      for (const action of ACTIONS) {
        const needs = subject.actions[action] ?? [];
        if (needs.length === 0 || !needs.every((n) => held.has(n))) continue;
        given.push(action);
        for (const n of needs) used.add(n);
      }
      const ct = subject.contentType;
      if (
        ct.options?.draftPublish === true &&
        (given.includes("create") || given.includes("update"))
      )
        given.push("publish");
      const left = [...held].filter((a) => !used.has(a)).sort();
      if (left.length > 0) {
        gaps.push({
          ...gap(
            name,
            `${left.map((a) => `${prefix}.${a}`).join(", ")}: a camis grant on ${ct.name} stands for ${describe(subject)}, so a role holding only part of one is not granted it`,
          ),
          location: { contentType: ct.name, rule: name },
        });
      }
      if (given.length === 0) continue;
      if (!contentTypes.includes(ct)) contentTypes.push(ct);
      grants.push({ contentType: ct.name, actions: given });
    }
    grants.sort((a, b) => a.contentType.localeCompare(b.contentType));
    const description = textOf(e.data.description);
    return { name, ...(description === "" ? {} : { description }), grants };
  });

  const defaultRole = defaultRoleOf(archive);
  return {
    document: { ...input, contentTypes },
    roles: {
      ...(defaultRole !== undefined && roles.some((r) => r.name === defaultRole)
        ? { defaultRole }
        : {}),
      roles,
    },
    gaps,
  };
};

const subjectOf = (
  prefix: string,
  contentTypes: ContentType[],
  builtin: (kind: "user" | "file", fallback: ContentType) => ContentType,
): Subject | undefined => {
  if (prefix === UPLOAD_API)
    return {
      contentType: builtin("file", BUILTIN_FILE),
      prefix,
      actions: suffixes(prefix, FILE_API_ACTIONS),
    };
  if (prefix === PLUGIN_USER_UID)
    return {
      contentType: builtin("user", BUILTIN_USER),
      prefix,
      actions: suffixes(prefix, USER_API_ACTIONS),
    };
  const ct = contentTypes.find((c) => c.builtin === undefined && strapiNames(c).uid === prefix);
  return ct === undefined
    ? undefined
    : { contentType: ct, prefix, actions: contentTypeActions(ct) };
};

const describe = (subject: Subject): string =>
  ACTIONS.flatMap((action) => {
    const needs = subject.actions[action] ?? [];
    return needs.length === 0 ? [] : [`${action} = ${needs.join(" + ")}`];
  }).join(", ");

const gap = (role: string, message: string): CapabilityGap => ({
  feature: "strapiPermission",
  location: { rule: role },
  severity: "downgrade",
  message: `role "${role}": ${message}`,
});
