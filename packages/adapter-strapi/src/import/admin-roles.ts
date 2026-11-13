import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Expression } from "@camis/expr";
import {
  ACTIONS,
  CREATED_BY,
  CREATOR_SHARES_ROLE,
  type Action,
  type Grant,
  type Role,
} from "@camis/permissions";
import { strapiNames } from "@camis/strapi-schema";
import { FILE_ADMIN_ACTIONS, PLUGIN_USER_UID, STRAPI_ACTION_UID } from "../permissions/actions";
import { BUILTIN_USER } from "./import-document";

/** A Strapi project's admin roles and their permissions, as its database holds them. */
export interface StrapiAdminData {
  /** admin_roles */
  roles: { id: number | string; name: string; code: string; description?: string | null }[];
  /** admin_permissions, each with the role it is linked to; properties and conditions parsed */
  permissions: {
    role: number | string;
    action: string;
    subject: string | null;
    properties: unknown;
    conditions: unknown;
  }[];
  /** The codes of the project's i18n locales. */
  locales: string[];
}

export interface ImportedAdminRoles {
  /** The document, with the builtin user or file type a role's grants needed added. */
  document: IrDocument;
  /** The admin roles, Strapi's Super Admin left out: the IR's super-admin stands for it. */
  roles: Role[];
  /** Whether Strapi had a Super Admin role. */
  superAdmin: boolean;
  gaps: CapabilityGap[];
}

const SUPER_ADMIN_CODE = "strapi-super-admin";

/**
 * Strapi's admin conditions as camis conditions: admin::is-creator, the entry's creator is the
 * caller; admin::has-same-role-as-creator, the creator holds one of the caller's roles.
 */
const ADMIN_CONDITIONS: ReadonlyMap<string, Expression> = new Map<string, Expression>([
  [
    "admin::is-creator",
    {
      kind: "eq",
      left: { kind: "var", name: CREATED_BY },
      right: { kind: "var", name: "user.id" },
    },
  ],
  [
    "admin::has-same-role-as-creator",
    {
      kind: "eq",
      left: { kind: "var", name: CREATOR_SHARES_ROLE },
      right: { kind: "lit", value: true },
    },
  ],
]);
const ORDER = [...ADMIN_CONDITIONS.keys()];

const BUILTIN_FILE: ContentType = { name: "File", kind: "collection", builtin: "file", fields: [] };

/**
 * The IR name of a Strapi admin role: its name in kebab case (Editor → editor), or one made of its
 * id when nothing of the name is left. The Filament target's `strapi:import-admins` names an
 * imported account's roles the same way.
 */
export const adminRoleName = (name: string, id: number | string): string => {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab === "" ? `admin-role-${id}` : kebab;
};

const ADMIN_ACTION = new Map<string, Action>(
  Object.entries(STRAPI_ACTION_UID).map(([action, uid]) => [uid, action as Action]),
);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

/**
 * The IR's admin roles from a Strapi project's admin roles and permissions: the inverse of the
 * admin projection (permissions/project.ts). An action Strapi gave only on the entries the account
 * created (admin::is-creator, as its default Author role has them) is granted under the condition
 * that the entry's creator is the caller. A camis grant covers every field and locale, so an
 * action Strapi gave on only some, or under another condition, is left out and reported: an import
 * never grants more than Strapi did. Settings and plugin actions have no IR counterpart and are
 * reported too.
 */
export const importStrapiAdminRoles = (
  data: StrapiAdminData,
  input: IrDocument,
  /** Role names the project already uses (the users' roles), which an admin role keeps clear of. */
  taken: readonly string[] = [],
): ImportedAdminRoles => {
  const gaps: CapabilityGap[] = [];
  const contentTypes = [...input.contentTypes];
  const builtin = (kind: "user" | "file", fallback: ContentType): ContentType =>
    contentTypes.find((ct) => ct.builtin === kind) ?? fallback;
  const used = new Set(taken);
  const superAdmin = data.roles.some((r) => r.code === SUPER_ADMIN_CODE);

  const roles = data.roles
    .filter((r) => r.code !== SUPER_ADMIN_CODE)
    .map((strapiRole): Role => {
      let name = adminRoleName(strapiRole.name, strapiRole.id);
      if (used.has(name)) name = `admin-${name}`;
      used.add(name);
      const report = (message: string, contentType?: string): void => {
        gaps.push({
          feature: "strapiAdminPermission",
          location: { rule: name, ...(contentType !== undefined ? { contentType } : {}) },
          severity: "downgrade",
          message: `admin role "${name}": ${message}`,
        });
      };
      // One line per type and reason, listing the actions, as a role holds one permission per
      // action and type and a project has dozens of types.
      const withheld = new Map<
        string,
        { contentType: string; actions: string[]; reason: string }
      >();
      const withhold = (ct: ContentType, uid: string, reason: string): void => {
        const key = `${ct.name}\u0000${reason}`;
        const entry =
          withheld.get(key) ??
          withheld.set(key, { contentType: ct.name, actions: [], reason }).get(key)!;
        entry.actions.push(uid);
      };
      const missing = new Set<string>();

      const held = new Map<ContentType, Set<Action>>();
      const hold = (ct: ContentType, actions: Action[]): void => {
        const set = held.get(ct) ?? held.set(ct, new Set()).get(ct)!;
        for (const a of actions) set.add(a);
      };
      // The actions held only on the entries the account created.
      // The actions held under each set of Strapi conditions, which Strapi ORs.
      const heldUnder = new Map<
        string,
        { condition: Expression; holding: Map<ContentType, Set<Action>> }
      >();
      const holdUnder = (names: string[], ct: ContentType, actions: Action[]): void => {
        const key = names.join(",");
        const conditions = names.map((n) => ADMIN_CONDITIONS.get(n)!);
        const under =
          heldUnder.get(key) ??
          heldUnder
            .set(key, {
              condition:
                conditions.length === 1 ? conditions[0]! : { kind: "or", args: conditions },
              holding: new Map(),
            })
            .get(key)!;
        const set = under.holding.get(ct) ?? under.holding.set(ct, new Set()).get(ct)!;
        for (const a of actions) set.add(a);
      };
      // Each upload action the role holds, with the Strapi conditions of each permission holding
      // it ("" for none).
      const fileActions = new Map<string, Set<string>>();
      const unimported: string[] = [];

      for (const p of data.permissions.filter((x) => String(x.role) === String(strapiRole.id))) {
        const action = ADMIN_ACTION.get(p.action);
        const isFile = p.action.startsWith("plugin::upload.") && fileActionUids.has(p.action);
        if (action === undefined && !isFile) {
          unimported.push(p.action);
          continue;
        }
        const ct = isFile
          ? builtin("file", BUILTIN_FILE)
          : subjectOf(p.subject, contentTypes, builtin);
        if (ct === undefined) {
          missing.add(p.subject ?? "");
          continue;
        }
        const conditions = strings(p.conditions) ?? [];
        if (conditions.some((c) => !ADMIN_CONDITIONS.has(c))) {
          withhold(ct, p.action, `only when ${conditions.join(", ")}; camis has no such condition`);
          continue;
        }
        const properties = record(p.properties);
        const fields = strings(properties.fields);
        const missingField =
          fields !== undefined &&
          ct.fields.some(
            (f) => !fields.some((path) => path.split(".")[0] === (f.names?.api ?? f.name)),
          );
        if (missingField) {
          withhold(
            ct,
            p.action,
            `only the fields ${fields.join(", ")}; a camis grant covers every field`,
          );
          continue;
        }
        const locales = strings(properties.locales);
        if (locales !== undefined && data.locales.some((code) => !locales.includes(code))) {
          withhold(
            ct,
            p.action,
            `only the locales ${locales.join(", ")}; a camis grant covers every locale`,
          );
          continue;
        }
        if (isFile) {
          const held =
            fileActions.get(p.action) ?? fileActions.set(p.action, new Set()).get(p.action)!;
          held.add(ORDER.filter((c) => conditions.includes(c)).join(","));
          if (!contentTypes.includes(ct)) contentTypes.push(ct);
          continue;
        }
        if (!contentTypes.includes(ct)) contentTypes.push(ct);
        if (conditions.length === 0) hold(ct, [action!]);
        else
          holdUnder(
            ORDER.filter((c) => conditions.includes(c)),
            ct,
            [action!],
          );
      }

      // A media library action is granted once the role holds every upload action it stands for.
      if (fileActions.size > 0) {
        const file = builtin("file", BUILTIN_FILE);
        // An upload action held outright needs no condition; else it takes the conditions it was given.
        const conditionOf = (uid: string): string => {
          const keys = fileActions.get(uid)!;
          return keys.has("") ? "" : [...keys].sort()[0]!;
        };
        const used = new Set<string>();
        for (const a of ACTIONS) {
          const needs = FILE_ADMIN_ACTIONS[a];
          if (needs.length === 0 || !needs.every((uid) => fileActions.has(uid))) continue;
          const keys = [...new Set(needs.map(conditionOf).filter((k) => k !== ""))];
          if (keys.length > 1) {
            for (const uid of needs) {
              withhold(
                file,
                uid,
                `its parts are held under different conditions (${keys.join("; ")})`,
              );
            }
            continue;
          }
          for (const uid of needs) used.add(uid);
          if (keys.length === 0) hold(file, [a]);
          else holdUnder(keys[0]!.split(","), file, [a]);
        }
        const left = [...fileActions.keys()].filter(
          (uid) => !used.has(uid) && ![...withheld.values()].some((w) => w.actions.includes(uid)),
        );
        if (left.length > 0) {
          withhold(
            file,
            left.join(", "),
            `a camis grant on ${file.name} stands for ${describeFileActions()}, and the role holds only part of one`,
          );
        }
      }
      for (const { contentType, actions, reason } of withheld.values()) {
        report(`${actions.join(", ")} on ${contentType}: ${reason}, so not granted`, contentType);
      }
      if (missing.size > 0) {
        report(
          `${[...missing].sort().join(", ")}: this project has no such type, so nothing on it is granted`,
        );
      }
      if (unimported.length > 0) {
        report(
          `${[...new Set(unimported)].sort().join(", ")}: settings and plugin actions are not imported; in camis the Settings pages follow the role's grants on the User type`,
        );
      }

      // An action held outright makes holding it under a condition moot.
      for (const { holding } of heldUnder.values()) {
        for (const [ct, actions] of holding) {
          for (const a of held.get(ct) ?? []) actions.delete(a);
        }
      }
      const grantsOf = (holding: Map<ContentType, Set<Action>>, condition?: Expression): Grant[] =>
        [...holding]
          .filter(([, actions]) => actions.size > 0)
          .map(([ct, actions]) => ({
            contentType: ct.name,
            actions: ACTIONS.filter((a) => actions.has(a)),
            ...(condition === undefined ? {} : { condition }),
          }));
      const grants: Grant[] = [
        ...grantsOf(held),
        ...[...heldUnder.values()].flatMap((u) => grantsOf(u.holding, u.condition)),
      ].sort((a, b) => a.contentType.localeCompare(b.contentType));
      const description = strapiRole.description ?? "";
      return { name, ...(description === "" ? {} : { description }), admin: true, grants };
    });

  return { document: { ...input, contentTypes }, roles, superAdmin, gaps };
};

const describeFileActions = (): string =>
  ACTIONS.flatMap((action) => {
    const needs = FILE_ADMIN_ACTIONS[action];
    return needs.length === 0 ? [] : [`${action} = ${needs.join(" + ")}`];
  }).join(", ");

const fileActionUids = new Set(Object.values(FILE_ADMIN_ACTIONS).flat());

const subjectOf = (
  subject: string | null,
  contentTypes: ContentType[],
  builtin: (kind: "user" | "file", fallback: ContentType) => ContentType,
): ContentType | undefined => {
  if (subject === PLUGIN_USER_UID) return builtin("user", BUILTIN_USER);
  return contentTypes.find((c) => c.builtin === undefined && strapiNames(c).uid === subject);
};
