import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { filamentNames } from "../names";
import { projectFilamentPermissions } from "../permissions/project";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitGeneratedController, emitProtectedController } from "./controller";
import { emitHasDraftAndPublish, emitStrapiDocuments } from "./draft-publish-runtime";
import {
  emitHasLocale,
  emitLocaleController,
  emitLocaleModel,
  emitLocalesMigration,
  emitStrapiLocales,
  LOCALES_MIGRATION_PATH,
} from "./i18n-runtime";
import { emitResourceFiles } from "../resource";
import { emitStrapiErrorsMiddleware } from "./errors";
import { mediaFields } from "./media";
import {
  emitFileModel,
  emitFileResourceFiles,
  emitFileSerializer,
  emitFilesMigration,
  emitHasMedia,
  emitMediaPicker,
  emitStrapiUpload,
  emitUploadController,
  FILES_MIGRATION_PATH,
} from "./media-runtime";
import { emitStrapiPopulate, emitStrapiRelations } from "./populate-runtime";
import { emitHasDocumentId, emitStrapiError, emitStrapiQuery } from "./rest-runtime";
import { emitApiConfig, emitStrapiRoutes } from "./routes";
import { emitScopeMethod } from "./scope";
import {
  emitConnectController,
  emitPasswordlessMigration,
  emitStrapiOAuth,
  emitStrapiProviders,
  PASSWORDLESS_MIGRATION_PATH,
} from "./oauth";
import { emitSerializer } from "./serializer";
import {
  emitRoleController,
  emitSessionController,
  emitSessionsMigration,
  emitStrapiSessions,
  SESSIONS_MIGRATION_PATH,
} from "./sessions";
import { kebab } from "./names";
import { wireShape } from "./wire-shape";
import { emitUserResourceFiles, emitUsersPermissionsSettingsPage } from "./users-permissions-admin";
import {
  emitSettingsMigration,
  emitStrapiActiveUser,
  emitStrapiCredentials,
  emitStrapiSettings,
  emitStrapiUsers,
  emitUserController,
  emitUsersPermissionsMigration,
  SETTINGS_MIGRATION_PATH,
  USERS_PERMISSIONS_MIGRATION_PATH,
} from "./users-permissions";

export interface StrapiApiInput {
  doc: IrDocument;
  bundle: IrBundle;
  emitted: ContentType[];
  fkNames: Map<string, string[]>;
  /** Draft-and-publish content types kept as two rows per document (`draftPublishPlan`). */
  versioned?: ReadonlySet<string>;
  /** Localized content types kept as one row per locale (`localizationPlan`). */
  localized?: ReadonlySet<string>;
  /** The builtin file type when the project keeps a media library (`mediaPlan`). */
  media?: ContentType | undefined;
  /** The default of `camis.rest.always_populate_components` (GenerateOptions). */
  alwaysPopulateComponents?: boolean;
  /** Callers without a session act as the IR's public role (`guestsPlan`). */
  guests?: boolean;
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
  const versioned = input.versioned ?? new Set<string>();
  const localized = input.localized ?? new Set<string>();
  const secured = bundle.roles.length > 0;
  const guests = input.guests === true;
  const perm = secured
    ? projectFilamentPermissions(doc, bundle.roles)
    : { readConditions: new Map<string, never>(), assigns: new Map<string, string[]>() };
  const files: GeneratedFile[] = [];
  const gaps: CapabilityGap[] = [];
  const scopeMethods = new Map<string, string>();
  const fileModel = input.media === undefined ? undefined : filamentNames(input.media).model;

  for (const ct of emitted) {
    const names = filamentNames(ct);
    const shape = wireShape(doc, ct, fkNames.get(ct.name) ?? [], versioned, localized, fileModel);
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
      const scope = emitScopeMethod(ct, perm.readConditions.get(ct.name), "laravel", guests);
      scopeMethods.set(ct.name, scope.php);
      if (scope.gap) gaps.push(scope.gap);
    }
  }

  files.push({
    path: "routes/api.php",
    content: emitStrapiRoutes(
      emitted,
      secured,
      "auth:sanctum",
      localized.size > 0,
      input.media !== undefined,
      true,
      guests,
    ),
  });
  files.push({
    path: "config/camis.php",
    content: emitApiConfig(
      "laravel",
      input.alwaysPopulateComponents === true,
      localized.size > 0,
      input.media !== undefined,
      true,
    ),
  });
  files.push({
    path: "app/Http/Controllers/Api/AuthController.php",
    content: emitAuthController(bundle.defaultRole),
  });
  files.push({ path: USERNAME_MIGRATION_PATH, content: emitUsernameMigration() });
  files.push(...usersPermissionsFiles(secured, guests, bundle.defaultRole));
  files.push({
    path: "app/Http/Middleware/StrapiErrors.php",
    content: emitStrapiErrorsMiddleware(),
  });
  files.push({ path: "app/Support/StrapiError.php", content: emitStrapiError() });
  files.push({ path: "app/Support/StrapiQuery.php", content: emitStrapiQuery(secured) });
  files.push({ path: "app/Support/StrapiPopulate.php", content: emitStrapiPopulate() });
  files.push({ path: "app/Support/StrapiRelations.php", content: emitStrapiRelations() });
  files.push({ path: "app/Models/Concerns/HasDocumentId.php", content: emitHasDocumentId() });
  if (localized.size > 0) files.push(...localeFiles());
  if (input.media !== undefined) {
    const scope = secured
      ? emitScopeMethod(input.media, perm.readConditions.get(input.media.name), "laravel", guests)
      : undefined;
    if (scope?.gap) gaps.push(scope.gap);
    files.push(...mediaLibraryFiles(input.media, emitted, secured, scope?.php));
  }
  if (versioned.size > 0) {
    files.push({ path: "app/Support/StrapiDocuments.php", content: emitStrapiDocuments() });
    files.push({
      path: "app/Models/Concerns/HasDraftAndPublish.php",
      content: emitHasDraftAndPublish(),
    });
  }
  return { files, gaps, scopeMethods };
};

/** users-permissions beyond register and login: accounts, their settings and their admin. */
const usersPermissionsFiles = (
  secured: boolean,
  guests: boolean,
  defaultRole: string | undefined,
): GeneratedFile[] => [
  { path: "app/Support/StrapiUsers.php", content: emitStrapiUsers() },
  { path: "app/Support/StrapiSettings.php", content: emitStrapiSettings() },
  {
    path: "app/Http/Controllers/Api/UserController.php",
    content: emitUserController(secured, guests),
  },
  { path: "app/Http/Middleware/StrapiActiveUser.php", content: emitStrapiActiveUser() },
  { path: "app/Http/Middleware/StrapiCredentials.php", content: emitStrapiCredentials() },
  { path: USERS_PERMISSIONS_MIGRATION_PATH, content: emitUsersPermissionsMigration() },
  { path: SETTINGS_MIGRATION_PATH, content: emitSettingsMigration() },
  { path: "app/Support/StrapiSessions.php", content: emitStrapiSessions() },
  { path: "app/Http/Controllers/Api/SessionController.php", content: emitSessionController() },
  { path: "app/Http/Controllers/Api/RoleController.php", content: emitRoleController() },
  { path: SESSIONS_MIGRATION_PATH, content: emitSessionsMigration() },
  { path: "app/Support/StrapiProviders.php", content: emitStrapiProviders(defaultRole) },
  { path: "app/Support/StrapiOAuth.php", content: emitStrapiOAuth() },
  { path: "app/Http/Controllers/Api/ConnectController.php", content: emitConnectController() },
  { path: PASSWORDLESS_MIGRATION_PATH, content: emitPasswordlessMigration() },
  ...emitUserResourceFiles(secured),
  {
    path: "app/Filament/Pages/UsersPermissionsSettings.php",
    content: emitUsersPermissionsSettingsPage(secured),
  },
];

/** The media library: Strapi's files and their upload API, and its admin. */
const mediaLibraryFiles = (
  file: ContentType,
  emitted: ContentType[],
  secured: boolean,
  scope: string | undefined,
): GeneratedFile[] => {
  const names = filamentNames(file);
  const targets = emitted
    .filter((ct) => mediaFields(ct).length > 0)
    .map((ct) => ({
      uid: `api::${kebab(ct.name)}.${kebab(ct.name)}`,
      model: filamentNames(ct).model,
    }));
  return [
    { path: "app/Support/StrapiUpload.php", content: emitStrapiUpload(names.model) },
    { path: "app/Models/Concerns/HasMedia.php", content: emitHasMedia() },
    {
      path: `app/Models/${names.model}.php`,
      content: emitFileModel(names.model, scope === undefined ? [] : [scope]),
    },
    {
      path: `app/Http/Serializers/${names.model}Serializer.php`,
      content: emitFileSerializer(names.model),
    },
    {
      path: "app/Http/Controllers/Api/UploadController.php",
      content: emitUploadController(names.model, targets, secured),
    },
    { path: FILES_MIGRATION_PATH, content: emitFilesMigration() },
    { path: "app/Filament/Support/MediaPicker.php", content: emitMediaPicker(names.model) },
    ...emitFileResourceFiles(names.model, names.resourceDir, names.resourceDir),
  ];
};

/** The locales a localized project keeps, with their admin resource (a plain Filament resource). */
const LOCALE: ContentType = {
  name: "Locale",
  kind: "collection",
  names: { plural: "Locales", collection: "i18n_locales" },
  fields: [
    { type: "string", name: "code", required: true, unique: true },
    { type: "string", name: "name", required: true },
    { type: "boolean", name: "isDefault" },
  ],
};

const localeFiles = (): GeneratedFile[] => [
  { path: "app/Support/StrapiLocales.php", content: emitStrapiLocales() },
  { path: "app/Models/Concerns/HasLocale.php", content: emitHasLocale() },
  { path: "app/Models/Locale.php", content: emitLocaleModel() },
  { path: "app/Http/Controllers/Api/LocaleController.php", content: emitLocaleController() },
  { path: LOCALES_MIGRATION_PATH, content: emitLocalesMigration() },
  ...emitResourceFiles(LOCALE),
];
