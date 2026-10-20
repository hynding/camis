import type { GeneratedFile, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { emitPolicy } from "./policy";
import { projectFilamentPermissions } from "./project";
import { emitPublicRole } from "./public-role";
import { emitRing1File } from "./ring1";
import { emitSeeder } from "./seeder";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
}

/**
 * Policies (and Ring1 behind them) are emitted on every layout. The Spatie seeder is not: a Strapi
 * database has no permission tables to seed, and the policies gate on the user's `up_roles` type
 * instead — so seeding one would create rows Strapi does not know about and nothing ever reads.
 * `guests` (see `emitPolicy`) also emits the public role's check.
 */
export const emitPermissions = (
  doc: IrDocument,
  roles: Role[],
  layout: StorageLayout = "laravel",
  guests = false,
): PermissionEmission => {
  if (roles.length === 0) return { files: [], gaps: [] };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const { permissionKeys, roleGrants, policies, gaps } = projectFilamentPermissions(doc, roles);
  const files: GeneratedFile[] =
    layout === "strapi"
      ? []
      : [
          {
            path: "database/seeders/RolePermissionSeeder.php",
            content: emitSeeder(permissionKeys, roleGrants),
          },
        ];
  for (const spec of policies) {
    files.push({
      path: `app/Policies/${spec.model}Policy.php`,
      content: emitPolicy(spec, byName.get(spec.contentType) as ContentType, layout, guests),
    });
  }
  if (guests) files.push({ path: "app/Support/PublicRole.php", content: emitPublicRole() });
  if (policies.some((p) => p.methods.some((m) => m.condition !== undefined))) {
    files.push({ path: "app/Support/Ring1.php", content: emitRing1File() });
  }
  return { files, gaps };
};
