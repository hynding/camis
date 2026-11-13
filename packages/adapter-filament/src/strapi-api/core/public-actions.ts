import type { ApiStyle, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import { runtimePhp } from "../../runtime-php";

export interface PublicActionsPlan {
  /** Whether a type's public actions are routed outside every credential check. */
  open: boolean;
  gaps: CapabilityGap[];
}

const listed = (actions: readonly string[]): string =>
  actions.length < 2
    ? actions.join("")
    : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]!}`;

/**
 * Only the Strapi API style on the laravel storage layout serves Strapi's route `auth: false`: the
 * Laravel API style requires a session on every route, and the Strapi storage layout checks Strapi's
 * own JWT on every one.
 */
export const publicActionsPlan = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: StorageLayout,
): PublicActionsPlan => {
  const opened = doc.contentTypes.filter((ct) => (ct.options?.publicApiActions ?? []).length > 0);
  if (opened.length === 0) return { open: false, gaps: [] };
  if (apiStyle === "strapi" && storage === "laravel") return { open: true, gaps: [] };
  return {
    open: false,
    gaps: opened.map((ct): CapabilityGap => {
      const actions = ct.options?.publicApiActions ?? [];
      return {
        feature: "publicApiActions",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `${ct.name} opens ${listed(actions)} to anyone, which only apiStyle "strapi" on the laravel storage layout serves; grant ${actions.length === 1 ? "it" : "them"} to the public role instead`,
      };
    }),
  };
};

/** The middleware on a public action's route; StrapiApiToken asks it whether a route is one. */
export const emitStrapiPublicRoute = (): string =>
  runtimePhp(new URL("./php/app/Http/Middleware/StrapiPublicRoute.php", import.meta.url));
