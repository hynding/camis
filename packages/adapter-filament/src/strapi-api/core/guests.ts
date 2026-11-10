import type { ApiStyle, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";
import { PUBLIC_ROLE, type Role } from "@camis/permissions";

export interface GuestsPlan {
  /** Whether callers without a session reach the API, with the public role's grants. */
  guests: boolean;
  gaps: CapabilityGap[];
}

/**
 * Only the Strapi API style on the laravel storage layout serves guests: the Laravel API style
 * requires a session on every route, and on the Strapi storage layout grants are role membership
 * checked against Strapi's own JWT, which a guest does not have.
 */
export const guestsPlan = (
  roles: Role[],
  apiStyle: ApiStyle,
  storage: StorageLayout,
): GuestsPlan => {
  if (!roles.some((r) => r.name === PUBLIC_ROLE)) return { guests: false, gaps: [] };
  if (apiStyle === "strapi" && storage === "laravel") return { guests: true, gaps: [] };
  return {
    guests: false,
    gaps: [
      {
        feature: "publicRole",
        location: { rule: PUBLIC_ROLE },
        severity: "downgrade",
        message: `the "${PUBLIC_ROLE}" role's grants are not served: ${
          apiStyle === "strapi"
            ? "the Strapi storage layout requires a Strapi session on every route"
            : 'the Laravel API style requires a session on every route (apiStyle "strapi" serves guests)'
        }`,
      },
    ],
  };
};
