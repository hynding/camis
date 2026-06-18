import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { PERMISSIONS_INDEX_TS } from "../skeleton/templates";
import { emitConditionsModule } from "./conditions";
import { projectPermissions } from "./project";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
  /** Replacement bootstrap when permissions are emitted (else undefined → keep skeleton default). */
  indexContent?: string;
}

export const emitPermissions = (doc: IrDocument, roles: Role[]): PermissionEmission => {
  if (roles.length === 0) return { files: [], gaps: [] };
  const { roles: emittedRoles, conditions, gaps } = projectPermissions(doc, roles);
  const files: GeneratedFile[] = [
    { path: "src/permissions/roles.json", content: stableJson(emittedRoles) },
  ];
  if (conditions.length > 0) {
    files.push({
      path: "src/permissions/conditions.ts",
      content: emitConditionsModule(conditions),
    });
  }
  return { files, gaps, indexContent: PERMISSIONS_INDEX_TS };
};
