import type { StorageLayout } from "@camis/adapter-kernel";
import { emitPhp } from "@camis/expr-php-emit";
import type { ContentType } from "@camis/ir-schema";
import { freeVars } from "@camis/expr";
import { CREATED_BY, CREATOR_SHARES_ROLE, PUBLIC_ROLE } from "@camis/permissions";
import { filamentNames, snakeColumn } from "../names";
import { phpSingleQuoted } from "../php-literal";
import type { PolicyMethodSpec, PolicySpec } from "./project";

// On a Strapi database there is no Spatie permission table: a user's only authorization datum is
// the `type` of the up_roles row it links to, so a grant check becomes role membership.
const userRole = (layout: StorageLayout): string =>
  layout === "strapi" ? "$user->roleType()" : "$user->getRoleNames()->first()";

const userData = (layout: StorageLayout): string[] => [
  "            'user.id' => $user->id,",
  "            'user.email' => $user->email,",
  `            'user.role' => ${userRole(layout)},`,
];

// A guest has no user values a condition could compare, only its role: an absent `user.id` makes
// a condition naming it fail closed, where a null one would equal every unowned row's.
const guestData = (layout: StorageLayout): string[] => [
  `            ...($user === null ? ['user.role' => '${PUBLIC_ROLE}'] : [`,
  ...userData(layout).map((line) => `    ${line}`),
  "            ]),",
];

// Strapi's createdBy is an admin account, while an API user's id is a row of another table:
// read as the creator's, it would match whichever entry an admin of the same id made.
const creatorData =
  "            'record.createdBy' => $user instanceof AdminUser ? $record->created_by_id : null,";

// Strapi's has-same-role-as-creator: the creating admin account holds one of the caller's roles.
const sharesRoleData =
  "            'record.creatorSharesRole' => $user instanceof AdminUser && $record->created_by_id !== null && AdminUser::query()->whereKey($record->created_by_id)->whereHas('roles', fn ($role) => $role->whereKey($user->roles->modelKeys()))->exists(),";

const recordData = (
  ct: ContentType,
  layout: StorageLayout,
  creator: boolean,
  sharesRole: boolean,
): string[] => [
  ...ct.fields
    .filter((f) => f.type !== "relation" && f.type !== "component")
    .map(
      (f) =>
        `            ${phpSingleQuoted(`record.${f.name}`)} => $record->${snakeColumn(f.name)},`,
    ),
  // Owning relations expose their FK as record.<name>Id so conditions can express ownership.
  // On the Strapi layout the FK is a link-table row, not a column, so the model's accessor is
  // the only way to reach it.
  ...ct.fields
    .filter(
      (f) =>
        f.type === "relation" && (f.relationKind === "manyToOne" || f.relationKind === "oneToOne"),
    )
    .map(
      (f) =>
        `            ${phpSingleQuoted(`record.${f.name}Id`)} => $record->${
          layout === "strapi" ? `${f.name}Id` : `${snakeColumn(f.name)}_id`
        },`,
    ),
  ...(creator && !ct.fields.some((f) => `record.${f.name}` === CREATED_BY) ? [creatorData] : []),
  ...(sharesRole && !ct.fields.some((f) => `record.${f.name}` === CREATOR_SHARES_ROLE)
    ? [sharesRoleData]
    : []),
];

/**
 * No role holds the key, so nothing the method could evaluate can grant it. Wrapping a condition
 * in `if (! false)` would leave unreachable code reading as if the condition still decided.
 */
const alwaysDenies = (m: PolicyMethodSpec): boolean => m.roles.length === 0;

/** The boolean expression that decides whether $user holds the method's grant at all. */
const grantCheck = (m: PolicyMethodSpec, layout: StorageLayout, guests: boolean): string => {
  if (alwaysDenies(m)) return "false";
  if (guests) return `PublicRole::allows($user, ${phpSingleQuoted(m.key)})`;
  if (layout !== "strapi") return `$user->can(${phpSingleQuoted(m.key)})`;
  return `in_array($user->roleType(), [${m.roles.map(phpSingleQuoted).join(", ")}], true)`;
};

/**
 * Whether $user holds one of `roles`. A guest holds only the public role, and a signed-in user
 * never does (PublicRole).
 */
const holdsRole = (roles: string[], layout: StorageLayout, guests: boolean): string => {
  const list = (names: string[]): string => `[${names.map(phpSingleQuoted).join(", ")}]`;
  if (layout === "strapi") return `in_array($user->roleType(), ${list(roles)}, true)`;
  if (!guests) return `$user->hasAnyRole(${list(roles)})`;
  const others = roles.filter((r) => r !== PUBLIC_ROLE);
  if (others.length === roles.length) return `$user !== null && $user->hasAnyRole(${list(roles)})`;
  return others.length === 0
    ? "$user === null"
    : `$user === null || $user->hasAnyRole(${list(others)})`;
};

/** Whether the method's body actually evaluates a condition (and so needs Ring1). */
const evaluatesCondition = (m: PolicyMethodSpec): boolean =>
  m.conditions !== undefined && !alwaysDenies(m);

// The admin signs in as an AdminUser and an API caller is a User, and a policy decides for both;
// the Strapi storage layout has no admin.
const userType = (layout: StorageLayout): string =>
  layout === "strapi" ? "User" : "User|AdminUser";

const RESULT_HOLDS = "$result['ok'] === true && $result['value'] === true";

const method = (
  m: PolicyMethodSpec,
  ct: ContentType,
  layout: StorageLayout,
  guests: boolean,
): string => {
  const user = `${userType(layout)}${guests ? "|null" : ""} $user`;
  const sig = m.record
    ? `    public function ${m.method}(${user}, ${filamentNames(ct).model} $record): bool`
    : `    public function ${m.method}(${user}): bool`;
  const check = grantCheck(m, layout, guests);
  if (m.conditions === undefined || alwaysDenies(m)) {
    return `${sig}\n    {\n        return ${check};\n    }`;
  }
  const groups = m.conditions;
  const conditioned = new Set(groups.flatMap((g) => g.roles));
  const outright = m.roles.filter((r) => !conditioned.has(r));
  const creator = groups.some((g) => freeVars(g.condition).includes(CREATED_BY));
  const sharesRole = groups.some((g) => freeVars(g.condition).includes(CREATOR_SHARES_ROLE));
  const data = [
    ...(guests ? guestData(layout) : userData(layout)),
    ...(m.record ? recordData(ct, layout, creator, sharesRole) : []),
  ].join("\n");
  const head = `${sig}
    {
        if (! ${check}) {
            return false;
        }
${outright.length > 0 ? `        if (${holdsRole(outright, layout, guests)}) {\n            return true;\n        }\n` : ""}        $data = [
${data}
        ];`;
  // Every role holding the key is held to the one condition, so holding the key is enough.
  if (outright.length === 0 && groups.length === 1) {
    return `${head}
        $result = ${emitPhp(groups[0]!.condition)};
        return ${RESULT_HOLDS};
    }`;
  }
  const tries = groups
    .map(
      (g) => `        if (${holdsRole(g.roles, layout, guests)}) {
            $result = ${emitPhp(g.condition)};
            if (${RESULT_HOLDS}) {
                return true;
            }
        }`,
    )
    .join("\n");
  return `${head}
${tries}

        return false;
    }`;
};

/**
 * `guests`: the project serves callers without a session (an IR public role, on a layout with a
 * permission table), so every method takes a nullable user and asks the public role for a guest.
 */
export const emitPolicy = (
  spec: PolicySpec,
  ct: ContentType,
  layout: StorageLayout = "laravel",
  guests = false,
): string => {
  const hasCondition = spec.methods.some((m) => evaluatesCondition(m));
  const supportUses = [
    ...(guests ? ["use App\\Support\\PublicRole;\n"] : []),
    ...(hasCondition ? ["use App\\Support\\Ring1;\n"] : []),
  ].join("");
  const body = spec.methods.map((m) => method(m, ct, layout, guests)).join("\n\n");
  return `<?php

declare(strict_types=1);

namespace App\\Policies;

${[...new Set([spec.model, ...(layout === "strapi" ? [] : ["AdminUser"]), "User"])]
  .sort()
  .map((model) => `use App\\Models\\${model};`)
  .join("\n")}
${supportUses}
class ${spec.model}Policy
{
${body}
}
`;
};
