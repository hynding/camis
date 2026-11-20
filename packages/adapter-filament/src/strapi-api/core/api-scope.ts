import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import { PUBLIC_ROLE } from "@camis/permissions";
import { phpSingleQuoted } from "../../php-literal";
import type { AdminReadScope } from "../../permissions/project";
import {
  renderEloquent,
  toWhereNode,
  whereContext,
  withoutUser,
  type WhereNode,
} from "./query-ast";

export interface ApiScopeEmit {
  php: string;
  gaps: CapabilityGap[];
  /**
   * The scope holds exactly the rows the policy's view lets through. Otherwise a role's
   * condition is outside SQL, its rows pass the scope unfiltered, and a list must filter them
   * through the policy before it pages.
   */
  exact: boolean;
}

export interface ApiScopeOptions {
  /** The project serves callers without a session, who hold the public role. */
  guests: boolean;
  /** API tokens reach the API; they act for no user and read every row. */
  tokens: boolean;
  /** Types serve public actions (StrapiPublicRoute), whose routes read every row too. */
  open: boolean;
}

const roleList = (roles: string[]): string => `[${roles.map(phpSingleQuoted).join(", ")}]`;

/** Whether $user holds one of `roles`; a guest holds only the public role. */
const holds = (roles: string[], guests: boolean): string => {
  if (!guests) return `$user->hasAnyRole(${roleList(roles)})`;
  const others = roles.filter((r) => r !== PUBLIC_ROLE);
  const signedIn =
    others.length > 0 ? `$user !== null && $user->hasAnyRole(${roleList(others)})` : "";
  if (others.length === roles.length) return signedIn;
  return signedIn === "" ? "$user === null" : `$user === null || (${signedIn})`;
};

const orWhere = (
  node: WhereNode,
): string => `                $q->orWhere(function (Builder $q) use ($user): void {
                    ${renderEloquent(node, "$q", "$user")}
                });`;

const branch = (check: string, body: string): string => `            if (${check}) {
${body}
            }`;

const ALL_ROWS = "                $q->orWhereRaw('1 = 1');";

/** The rows one group of roles reads: the guest's share without the user, the others' with it. */
const groupBranches = (roles: string[], node: WhereNode, guests: boolean): string[] => {
  const signedIn = roles.filter((r) => !guests || r !== PUBLIC_ROLE);
  const branches = signedIn.length > 0 ? [branch(holds(signedIn, guests), orWhere(node))] : [];
  if (guests && roles.includes(PUBLIC_ROLE)) {
    const guest = withoutUser(node);
    if (guest === true) branches.push(branch("$user === null", ALL_ROWS));
    else if (guest !== false) branches.push(branch("$user === null", orWhere(guest)));
  }
  return branches;
};

/**
 * The model's `forUser` scope, which the content API lists, shows and edits through. Strapi
 * shows a caller the entries one of its role's read conditions holds for, so the scope gives a
 * role reading outright every row and each other role the rows its own condition lets through,
 * the same rows the policy's view allows: a page counts and holds only rows the caller may see.
 */
export const emitApiScopeMethod = (
  ct: ContentType,
  scope: AdminReadScope | undefined,
  options: ApiScopeOptions,
): ApiScopeEmit => {
  const { guests, tokens, open } = options;
  const nullable = guests || tokens;
  const signature = `    /** Rows visible to $user (Strapi API style list scope): each role's read condition, in SQL. */
    public function scopeForUser(Builder $q, ${nullable ? "?User" : "User"} $user): Builder
    {`;
  if (scope === undefined) {
    return { php: `${signature}\n        return $q;\n    }`, gaps: [], exact: true };
  }
  const context = whereContext(ct, "laravel");
  const gaps: CapabilityGap[] = [];
  const tries: string[] = [];
  for (const group of scope.conditions) {
    const node = toWhereNode(group.condition, context);
    if (node === null) {
      gaps.push(
        ...group.roles.map(
          (role): CapabilityGap => ({
            feature: "listScopeFallback",
            location: { contentType: ct.name, rule: role },
            severity: "downgrade",
            message: `role "${role}" reads "${ct.name}" under a condition outside the SQL subset (eq/and/or over record.* vs literal or user.id); its list is filtered per record through the policy before paging`,
          }),
        ),
      );
      tries.push(branch(holds(group.roles, guests), ALL_ROWS));
      continue;
    }
    tries.push(...groupBranches(group.roles, node, guests));
  }
  const bypass = tokens
    ? `        if (\\App\\Support\\StrapiApiTokens::active()${
        open ? " || \\App\\Http\\Middleware\\StrapiPublicRoute::active()" : ""
      }) {
            return $q;
        }
`
    : "";
  const outright =
    scope.unconditional.length > 0
      ? `        if (${holds(scope.unconditional, guests)}) {
            return $q;
        }
`
      : "";
  const guards = bypass + outright;
  const php = `${signature}
${guards}${guards === "" ? "" : "\n"}        return $q->where(function (Builder $q) use ($user): void {
            $q->whereRaw('1 = 0');${tries.length > 0 ? `\n${tries.join("\n")}` : ""}
        });
    }`;
  return { php, gaps, exact: gaps.length === 0 };
};
