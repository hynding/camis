import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { PERMISSIONS_INDEX_TS } from "../skeleton/templates";
import {
  checkedSingleSource,
  emitApiEnforcementFiles,
  enforcedControllerSource,
} from "./api-enforcement-emit";
import { projectApiEnforcement, type ApiEnforcement } from "./api-enforcement";
import { emitConditionsModule } from "./conditions";
import { projectApiRoles, projectPermissions } from "./project";

/** The condition module of roles with no condition: the bootstrap registers none. */
const NO_CONDITIONS = "export const conditions: unknown[] = [];\n";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
  /** Replacement bootstrap when permissions are emitted (else undefined → keep skeleton default). */
  indexContent?: string;
  /** Replacement controller per content type uid whose content API actions are enforced. */
  controllers: Map<string, string>;
}

const controllersOf = (enforcement: ApiEnforcement): Map<string, string> =>
  new Map(
    enforcement.types.map((t) => [
      t.uid,
      enforcement.singles.includes(t.uid)
        ? checkedSingleSource(t.uid)
        : enforcedControllerSource(t.uid),
    ]),
  );

/**
 * With no roles, an `auth: false` route is still open to anyone: its requests are enforced, and
 * the bootstrap, which has no role to grant, stays the skeleton's.
 */
const openRoutesOnly = (doc: IrDocument): PermissionEmission => {
  if (!doc.contentTypes.some((ct) => (ct.options?.publicApiActions ?? []).length > 0))
    return { files: [], gaps: [], controllers: new Map() };
  const enforcement = projectApiEnforcement(doc, []);
  return {
    files: emitApiEnforcementFiles(enforcement),
    gaps: enforcement.gaps,
    controllers: controllersOf(enforcement),
  };
};

export const emitPermissions = (doc: IrDocument, roles: Role[]): PermissionEmission => {
  if (roles.length === 0) return openRoutesOnly(doc);
  const { roles: emittedRoles, conditions, gaps } = projectPermissions(doc, roles);
  const apiRoles = projectApiRoles(doc, roles);
  const enforcement = projectApiEnforcement(doc, roles);
  const files: GeneratedFile[] = [
    { path: "src/permissions/roles.json", content: stableJson(emittedRoles) },
    {
      path: "src/permissions/api-roles.json",
      content: stableJson({ roles: apiRoles.roles, public: apiRoles.public }),
    },
  ];
  // The bootstrap imports the module whether or not any role has a condition.
  files.push({
    path: "src/permissions/conditions.ts",
    content: conditions.length > 0 ? emitConditionsModule(conditions) : NO_CONDITIONS,
  });
  files.push(...emitApiEnforcementFiles(enforcement));
  return {
    files,
    gaps: [...gaps, ...apiRoles.gaps, ...enforcement.gaps],
    indexContent: PERMISSIONS_INDEX_TS,
    controllers: controllersOf(enforcement),
  };
};
