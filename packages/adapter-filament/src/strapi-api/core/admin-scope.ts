import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import { phpSingleQuoted } from "../../php-literal";
import type { AdminReadScope } from "../../permissions/project";
import { renderEloquent, toWhereNode, whereContext } from "./query-ast";

export interface AdminScopeEmit {
  php: string;
  gaps: CapabilityGap[];
}

const roleList = (roles: string[]): string => `[${roles.map(phpSingleQuoted).join(", ")}]`;

/**
 * The model's `forAdmin` scope, which the Content Manager lists through: Strapi lists only the
 * entries a role's read condition lets through (an Author sees the ones it created), so an admin
 * account sees every row through a role reading outright and, through each other role reading
 * the type, the rows its condition holds for. A condition SQL cannot express lists nothing for
 * its roles, as listing every row would show entries the account may not open.
 */
export const emitAdminScopeMethod = (ct: ContentType, scope: AdminReadScope): AdminScopeEmit => {
  const context = whereContext(ct, "laravel", true);
  const gaps: CapabilityGap[] = [];
  const tries: string[] = [];
  for (const group of scope.conditions) {
    const node = toWhereNode(group.condition, context);
    if (node === null) {
      gaps.push(
        ...group.roles.map(
          (role): CapabilityGap => ({
            feature: "adminListScope",
            location: { contentType: ct.name, rule: role },
            severity: "downgrade",
            message: `admin role "${role}" reads "${ct.name}" under a condition outside the SQL subset (eq/and/or over record.* vs literal or user.id); its Content Manager list shows none of it`,
          }),
        ),
      );
      continue;
    }
    tries.push(`            if ($user->hasAnyRole(${roleList(group.roles)})) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    ${renderEloquent(node, "$q", "$user")}
                });
            }`);
  }
  const outright =
    scope.unconditional.length > 0
      ? `        if ($user->hasAnyRole(${roleList(scope.unconditional)})) {
            return $q;
        }
`
      : "";
  const php = `    /** Rows an admin account may list in the Content Manager, as its roles' read conditions allow. */
    public function scopeForAdmin(Builder $q, ?\\Illuminate\\Contracts\\Auth\\Authenticatable $user): Builder
    {
        if (! $user instanceof AdminUser) {
            return $q->whereRaw('1 = 0');
        }
${outright}
        return $q->where(function (Builder $q) use ($user): void {
            $q->whereRaw('1 = 0');${tries.length > 0 ? `\n${tries.join("\n")}` : ""}
        });
    }`;
  return { php, gaps };
};
