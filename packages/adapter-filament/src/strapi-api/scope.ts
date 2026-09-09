import type { Expression } from "@camis/expr";
import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import { renderEloquent, toWhereNode, whereContext, type StorageLayout } from "./query-ast";

export interface ScopeEmit {
  php: string;
  gap?: CapabilityGap;
}

const method = (body: string): string =>
  `    /** Rows visible to $user (Strapi API style list scope). */\n    public function scopeForUser(Builder $q, User $user): Builder\n    {\n${body}\n    }`;

export const emitScopeMethod = (
  ct: ContentType,
  condition: Expression | undefined,
  layout: StorageLayout = "laravel",
): ScopeEmit => {
  if (condition === undefined) return { php: method("        return $q;") };
  const node = toWhereNode(condition, whereContext(ct, layout));
  if (node === null) {
    return {
      php: method("        return $q;"),
      gap: {
        feature: "listScopeFallback",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `read condition on "${ct.name}" is outside the SQL subset (eq/and/or over record.* vs literal or user.id); lists are filtered per record through the policy instead`,
      },
    };
  }
  return { php: method(`        ${renderEloquent(node, "$q", "$user")}\n\n        return $q;`) };
};
