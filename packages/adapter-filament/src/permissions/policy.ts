import type { StorageLayout } from "@camis/adapter-kernel";
import { emitPhp } from "@camis/expr-php-emit";
import type { ContentType } from "@camis/ir-schema";
import { PUBLIC_ROLE } from "@camis/permissions";
import { snakeColumn } from "../names";
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

const recordData = (ct: ContentType, layout: StorageLayout): string[] => [
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
];

/**
 * No role holds the key, so nothing the method could evaluate can grant it. Wrapping a condition
 * in `if (! false)` would leave unreachable code reading as if the condition still decided.
 */
const alwaysDenies = (m: PolicyMethodSpec, layout: StorageLayout): boolean =>
  layout === "strapi" && m.roles.length === 0;

/** The boolean expression that decides whether $user holds the method's grant at all. */
const grantCheck = (m: PolicyMethodSpec, layout: StorageLayout, guests: boolean): string => {
  if (guests) return `PublicRole::allows($user, ${phpSingleQuoted(m.key)})`;
  if (layout !== "strapi") return `$user->can(${phpSingleQuoted(m.key)})`;
  if (m.roles.length === 0) return "false";
  return `in_array($user->roleType(), [${m.roles.map(phpSingleQuoted).join(", ")}], true)`;
};

/** Whether the method's body actually evaluates its condition (and so needs Ring1). */
const evaluatesCondition = (m: PolicyMethodSpec, layout: StorageLayout): boolean =>
  m.condition !== undefined && !alwaysDenies(m, layout);

const method = (
  m: PolicyMethodSpec,
  ct: ContentType,
  layout: StorageLayout,
  guests: boolean,
): string => {
  const user = guests ? "?User $user" : "User $user";
  const sig = m.record
    ? `    public function ${m.method}(${user}, ${ct.name} $record): bool`
    : `    public function ${m.method}(${user}): bool`;
  const check = grantCheck(m, layout, guests);
  if (m.condition === undefined || alwaysDenies(m, layout)) {
    return `${sig}\n    {\n        return ${check};\n    }`;
  }
  const data = [
    ...(guests ? guestData(layout) : userData(layout)),
    ...(m.record ? recordData(ct, layout) : []),
  ].join("\n");
  return `${sig}
    {
        if (! ${check}) {
            return false;
        }
        $data = [
${data}
        ];
        $result = ${emitPhp(m.condition)};
        return $result['ok'] === true && $result['value'] === true;
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
  const hasCondition = spec.methods.some((m) => evaluatesCondition(m, layout));
  const supportUses = [
    ...(guests ? ["use App\\Support\\PublicRole;\n"] : []),
    ...(hasCondition ? ["use App\\Support\\Ring1;\n"] : []),
  ].join("");
  const body = spec.methods.map((m) => method(m, ct, layout, guests)).join("\n\n");
  return `<?php

declare(strict_types=1);

namespace App\\Policies;

use App\\Models\\${spec.model};
use App\\Models\\User;
${supportUses}
class ${spec.model}Policy
{
${body}
}
`;
};
