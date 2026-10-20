import type { Expression } from "@camis/expr";
import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import {
  renderEloquent,
  toWhereNode,
  whereContext,
  withoutUser,
  type StorageLayout,
  type WhereNode,
} from "./query-ast";

export interface ScopeEmit {
  php: string;
  gap?: CapabilityGap;
}

const method = (body: string, guests: boolean): string =>
  guests
    ? `    /** Rows visible to $user (Strapi API style list scope); null is a caller without a session. */\n    public function scopeForUser(Builder $q, ?User $user): Builder\n    {\n${body}\n    }`
    : `    /** Rows visible to $user (Strapi API style list scope). */\n    public function scopeForUser(Builder $q, User $user): Builder\n    {\n${body}\n    }`;

const filtered = (node: WhereNode | boolean, indent: string): string => {
  if (node === true) return `${indent}return $q;`;
  const where = node === false ? "$q->whereRaw('1 = 0');" : renderEloquent(node, "$q", "$user");
  return `${indent}${where}\n\n${indent}return $q;`;
};

/** A guest's own filter first, when the condition names the user (whose rows a guest has none of). */
const body = (node: WhereNode, guests: boolean): string => {
  const guest = withoutUser(node);
  if (!guests || JSON.stringify(guest) === JSON.stringify(node)) return filtered(node, "        ");
  return `        if ($user === null) {\n${filtered(guest, "            ")}\n        }\n${filtered(node, "        ")}`;
};

/** `guests`: the project serves callers without a session, so the scope accepts a null user. */
export const emitScopeMethod = (
  ct: ContentType,
  condition: Expression | undefined,
  layout: StorageLayout = "laravel",
  guests = false,
): ScopeEmit => {
  if (condition === undefined) return { php: method("        return $q;", guests) };
  const node = toWhereNode(condition, whereContext(ct, layout));
  if (node === null) {
    return {
      php: method("        return $q;", guests),
      gap: {
        feature: "listScopeFallback",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `read condition on "${ct.name}" is outside the SQL subset (eq/and/or over record.* vs literal or user.id); lists are filtered per record through the policy instead`,
      },
    };
  }
  return { php: method(body(node, guests), guests) };
};
