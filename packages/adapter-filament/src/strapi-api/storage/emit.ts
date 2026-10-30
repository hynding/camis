import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";
import { filamentNames } from "../../names";
import { projectFilamentPermissions } from "../../permissions/project";
import { emitGeneratedController, emitProtectedController } from "../controller";
import type { StrapiApiEmission, StrapiApiInput } from "../emit";
import { emitStrapiErrorsMiddleware } from "../errors";
import { emitStrapiError } from "../rest-runtime";
import { emitApiConfig, emitStrapiRoutes } from "../routes";
import { emitScopeMethod } from "../scope";
import { emitSerializer } from "../serializer";
import { wireShape } from "../wire-shape";
import { emitStorageAuthController } from "./auth";
import { componentMap } from "./component-map";
import { emitStorageModel, emitStorageUpRoleModel, emitStorageUserModel } from "./model";
import { ownerLinks } from "./names";
import {
  emitStrapiComponentAttributes,
  emitStrapiComponents,
  emitStrapiDateTime,
  emitStrapiJwtGuard,
  emitStrapiRows,
} from "./runtime";
import { emitSchemaCheck, expectedSchema } from "./schema-check";

/**
 * The Strapi-storage layout's own gaps, per content type. Everything here is a shape the layout
 * physically cannot serve: an owner-side `manyToMany`/`oneToMany` needs a link table this code
 * never reads, `media` needs Strapi's upload plugin tables, `dynamicZone` has no single component
 * table to map, and `draftPublish` needs the draft/published document pairing Strapi's own content
 * API resolves. Reported rather than silently dropped (CLAUDE.md "capability gaps").
 */
const contentTypeGaps = (ct: StrapiApiInput["emitted"][number]): CapabilityGap[] => {
  const gaps: CapabilityGap[] = [];
  for (const f of ct.fields) {
    if (f.type === "relation") {
      if (f.relationKind === "manyToMany" || f.relationKind === "oneToMany") {
        gaps.push({
          feature: "relationKind",
          location: { contentType: ct.name, field: f.name },
          severity: "error",
          message: `relation "${f.name}" is ${f.relationKind}; the strapi storage layout reads and writes only the owning side of a link table (manyToOne/oneToOne)`,
        });
      }
      continue;
    }
    if (f.type === "media" || f.type === "dynamicZone") {
      gaps.push({
        feature: f.type,
        location: { contentType: ct.name, field: f.name },
        severity: "error",
        message: `field type "${f.type}" has no physical column the strapi storage layout can read or write; Strapi's own API owns it`,
      });
    }
  }
  if (ct.options?.draftPublish === true) {
    gaps.push({
      feature: "draftPublish",
      location: { contentType: ct.name },
      severity: "downgrade",
      message: `"${ct.name}" enables draftPublish; the strapi storage layout reads rows directly and does not resolve a draft against its published document`,
    });
  }
  return gaps;
};

/**
 * The full Strapi-storage file set. Unlike `emitStrapiApi` (the Sanctum-backed API over a Laravel
 * schema), this layout owns its models too: relations are link-table rows and components live in
 * their own tables, so the model is inseparable from the controller and serializer that read it.
 *
 * `scopeMethods` is still returned for interface parity with `emitStrapiApi`; on this layout the
 * scopes are already spliced into the models emitted here, so `generate.ts` never reads it.
 */
export const emitStrapiStorage = (input: StrapiApiInput): StrapiApiEmission => {
  const { doc, bundle, emitted, observedModels } = input;
  const secured = bundle.roles.length > 0;
  const perm = secured
    ? projectFilamentPermissions(doc, bundle.roles)
    : { readConditions: new Map<string, never>(), assigns: new Map<string, string[]>() };
  const files: GeneratedFile[] = [];
  const gaps: CapabilityGap[] = [];
  const scopeMethods = new Map<string, string>();

  for (const ct of emitted) {
    const names = filamentNames(ct);
    // No foreign-key columns on this layout: an owning relation is a link-table row, so the
    // serializer's `$wire['columns']` must name only columns the model can actually fill.
    const shape = wireShape(doc, ct, []);
    files.push({
      path: `app/Http/Serializers/${names.model}Serializer.php`,
      content: emitSerializer(shape, "strapi"),
    });
    files.push({
      path: `app/Http/Controllers/Api/Generated/${names.model}ApiController.php`,
      content: emitGeneratedController({
        shape,
        ct,
        assigns: perm.assigns.get(ct.name) ?? [],
        secured,
        scoped: secured,
        layout: "strapi",
        links: ownerLinks(ct),
      }),
    });
    files.push({
      path: `app/Http/Controllers/Api/${names.model}ApiController.php`,
      content: emitProtectedController(names.model),
      mode: "seed",
    });
    let scopeMethod: string | undefined;
    if (secured) {
      const scope = emitScopeMethod(ct, perm.readConditions.get(ct.name), "strapi");
      scopeMethod = scope.php;
      scopeMethods.set(ct.name, scope.php);
      if (scope.gap) gaps.push(scope.gap);
    }
    files.push({
      path: `app/Models/${names.model}.php`,
      content: emitStorageModel(
        ct,
        doc,
        componentMap(doc, ct),
        scopeMethod,
        observedModels?.has(ct.name) === true,
      ),
    });
    gaps.push(...contentTypeGaps(ct));
  }
  gaps.push({
    feature: "entityValidation",
    location: {},
    severity: "downgrade",
    message:
      "the strapi storage layout writes a request's fields as sent; Strapi's entity validator (required, lengths, regex, enumerations, bounds) runs only on the laravel layout",
  });

  // Strapi's users-permissions tables: the host Laravel app owns no `users` table here.
  files.push({ path: "app/Models/User.php", content: emitStorageUserModel() });
  files.push({ path: "app/Models/UpRole.php", content: emitStorageUpRoleModel() });

  files.push({ path: "app/Casts/StrapiDateTime.php", content: emitStrapiDateTime() });
  files.push({ path: "app/Support/StrapiRows.php", content: emitStrapiRows() });
  files.push({ path: "app/Support/StrapiComponents.php", content: emitStrapiComponents() });
  files.push({
    path: "app/Support/StrapiComponentAttributes.php",
    content: emitStrapiComponentAttributes(),
  });
  files.push({ path: "app/Http/Middleware/StrapiJwtGuard.php", content: emitStrapiJwtGuard() });

  files.push({
    path: "routes/api.php",
    content: emitStrapiRoutes(emitted, secured, "strapi-jwt"),
  });
  files.push({ path: "config/camis.php", content: emitApiConfig("strapi") });
  files.push({
    path: "app/Http/Controllers/Api/AuthController.php",
    content: emitStorageAuthController(bundle.defaultRole),
  });
  files.push({
    path: "app/Http/Middleware/StrapiErrors.php",
    content: emitStrapiErrorsMiddleware(),
  });
  // The middleware renders it; this layout's controllers do not throw one yet.
  files.push({ path: "app/Support/StrapiError.php", content: emitStrapiError() });
  files.push({
    path: "app/Console/Commands/CamisStrapiSchemaCheck.php",
    content: emitSchemaCheck(expectedSchema(doc, emitted)),
  });

  // Project-level, not per content type: the whole Filament admin panel is out of scope on this
  // layout, because Strapi's own admin panel already edits the same rows.
  gaps.push({
    feature: "adminPanelNotEmitted",
    location: {},
    severity: "downgrade",
    message:
      "Filament admin panel resources are not emitted in the strapi storage layout; " +
      "Strapi's own admin panel owns content editing.",
  });

  gaps.push({
    feature: "usersPermissionsAccounts",
    location: {},
    severity: "downgrade",
    message:
      "the Strapi storage layout serves register, login and /users/me only; password reset and change, email confirmation, blocked users, refresh-token sessions, sign-in providers and /users are left to the Strapi instance",
  });
  gaps.push({
    feature: "apiTokens",
    location: {},
    severity: "downgrade",
    message:
      "the Strapi storage layout does not accept API tokens: the Strapi instance keeps and checks them",
  });
  gaps.push({
    feature: "webhooks",
    location: {},
    severity: "downgrade",
    message:
      "the Strapi storage layout sends no webhooks: a write through camis does not reach the webhooks the Strapi instance keeps",
  });
  return { files, gaps, scopeMethods };
};
