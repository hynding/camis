import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { filamentNames } from "../names";
import { projectFilamentPermissions } from "../permissions/project";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitGeneratedController, emitProtectedController } from "./controller";
import { emitStrapiErrorsMiddleware } from "./errors";
import { emitHasDocumentId, emitStrapiError, emitStrapiQuery } from "./rest-runtime";
import { emitApiConfig, emitStrapiRoutes } from "./routes";
import { emitScopeMethod } from "./scope";
import { emitSerializer } from "./serializer";
import { wireShape } from "./wire-shape";

export interface StrapiApiInput {
  doc: IrDocument;
  bundle: IrBundle;
  emitted: ContentType[];
  fkNames: Map<string, string[]>;
  /**
   * Content types whose model must declare `#[ObservedBy]` — hook observers plus AI-field
   * observers. Only the Strapi *storage* layout reads it: on the Laravel layout `emitModel`
   * owns the model and already receives the flag directly.
   */
  observedModels?: ReadonlySet<string>;
}
export interface StrapiApiEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
  /** content type name → scopeForUser PHP method (spliced into the model). */
  scopeMethods: Map<string, string>;
}

export const emitStrapiApi = (input: StrapiApiInput): StrapiApiEmission => {
  const { doc, bundle, emitted, fkNames } = input;
  const secured = bundle.roles.length > 0;
  const perm = secured
    ? projectFilamentPermissions(doc, bundle.roles)
    : { readConditions: new Map<string, never>(), assigns: new Map<string, string[]>() };
  const files: GeneratedFile[] = [];
  const gaps: CapabilityGap[] = [];
  const scopeMethods = new Map<string, string>();

  for (const ct of emitted) {
    const names = filamentNames(ct);
    const shape = wireShape(doc, ct, fkNames.get(ct.name) ?? []);
    files.push({
      path: `app/Http/Serializers/${names.model}Serializer.php`,
      content: emitSerializer(shape),
    });
    files.push({
      path: `app/Http/Controllers/Api/Generated/${names.model}ApiController.php`,
      content: emitGeneratedController({
        shape,
        ct,
        assigns: perm.assigns.get(ct.name) ?? [],
        secured,
        scoped: secured,
      }),
    });
    files.push({
      path: `app/Http/Controllers/Api/${names.model}ApiController.php`,
      content: emitProtectedController(names.model),
      mode: "seed",
    });
    if (secured) {
      const scope = emitScopeMethod(ct, perm.readConditions.get(ct.name));
      scopeMethods.set(ct.name, scope.php);
      if (scope.gap) gaps.push(scope.gap);
    }
  }

  files.push({ path: "routes/api.php", content: emitStrapiRoutes(emitted, secured) });
  files.push({ path: "config/camis.php", content: emitApiConfig() });
  files.push({
    path: "app/Http/Controllers/Api/AuthController.php",
    content: emitAuthController(bundle.defaultRole),
  });
  files.push({ path: USERNAME_MIGRATION_PATH, content: emitUsernameMigration() });
  files.push({
    path: "app/Http/Middleware/StrapiErrors.php",
    content: emitStrapiErrorsMiddleware(),
  });
  files.push({ path: "app/Support/StrapiError.php", content: emitStrapiError() });
  files.push({ path: "app/Support/StrapiQuery.php", content: emitStrapiQuery() });
  files.push({ path: "app/Models/Concerns/HasDocumentId.php", content: emitHasDocumentId() });
  return { files, gaps, scopeMethods };
};
