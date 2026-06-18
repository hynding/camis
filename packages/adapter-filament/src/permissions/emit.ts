import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { emitPolicy } from "./policy";
import { projectFilamentPermissions } from "./project";
import { emitRing1File } from "./ring1";
import { emitSeeder } from "./seeder";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
}

export const emitPermissions = (doc: IrDocument, roles: Role[]): PermissionEmission => {
  if (roles.length === 0) return { files: [], gaps: [] };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const { permissionKeys, roleGrants, policies, gaps } = projectFilamentPermissions(doc, roles);
  const files: GeneratedFile[] = [
    {
      path: "database/seeders/RolePermissionSeeder.php",
      content: emitSeeder(permissionKeys, roleGrants),
    },
  ];
  for (const spec of policies) {
    files.push({
      path: `app/Policies/${spec.model}Policy.php`,
      content: emitPolicy(spec, byName.get(spec.contentType) as ContentType),
    });
  }
  if (policies.some((p) => p.methods.some((m) => m.condition !== undefined))) {
    files.push({ path: "app/Support/Ring1.php", content: emitRing1File() });
  }
  return { files, gaps };
};
