import {
  buildManifest,
  columnField,
  expandComponents,
  privateFieldGaps,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import { strapiNames } from "@camis/strapi-schema";
import type { CapabilityGap } from "@camis/ir-schema";
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";
import {
  childMigrationFilename,
  childRelationMethod,
  childTableEmit,
  childTablesWithin,
  emitChildMigration,
  camelPath,
  emitChildModel,
  linksFilesWithin,
  relationPickers,
  repeaterComponent,
  type ChildTableEmit,
} from "./components";
import {
  componentPivotMigrationFilename,
  componentRelationMethod,
  componentRelationPicker,
  componentRelations,
  emitComponentPivotMigration,
  type ComponentPivot,
} from "./component-relations";
import { apiCustomSeed, emitApiController, emitApiRoutes } from "./api";
import { emitBlocksFiles, hasBlocksFields } from "./blocks";
import { emitJsonEditorFiles, hasJsonFields } from "./json-editor";
import { deployFile } from "./deploy";
import { emitField, isSupportedField } from "./fields";
import { emitHookFiles } from "./hooks/emit";
import { emitRouteHookFiles } from "./hooks/route-hooks";
import { emitScheduleFiles } from "./hooks/schedules";
import { emitPermissions } from "./permissions/emit";
import {
  emitForeignKeysMigration,
  emitMigration,
  emitPivotMigration,
  foreignKeysMigrationFilename,
  migrationFilename,
  pivotMigrationFilename,
} from "./migration";
import { migrationOrder } from "./migration-order";
import { emitModel } from "./model";
import { filamentNames, snake, snakeColumn } from "./names";
import { constrainedColumn, resolveRelations, type ForeignKeyColumn } from "./relations";
import { emitResourceFiles } from "./resource";
import { draftPublishPlan } from "./strapi-api/core/draft-publish";
import { guestsPlan } from "./strapi-api/core/guests";
import { localizationPlan, sharedAcrossLocalesMethod } from "./strapi-api/i18n/localization";
import {
  mediaAllowedTypes,
  mediaComponentsConstant,
  mediaFields,
  mediaPlan,
} from "./strapi-api/upload/media";
import { mediaRelationMethod } from "./strapi-api/upload/media-runtime";
import { contentManagerSorts, USER_DISPLAY_NAME } from "./strapi-api/admin/admin-navigation";
import { emitStrapiApi } from "./strapi-api/emit";
import { linkOrdersConstant } from "./strapi-api/core/link-order";
import { emitStrapiStorage } from "./strapi-api/storage/emit";
import { emitAdminAccessFiles } from "./admin-access";
import { zoneBuilder } from "./strapi-api/content-manager/zones-admin";
import { prohibitedCloningFields } from "./strapi-api/content-manager/content-manager";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir, options): GenerationResult => {
    const apiStyle = options.apiStyle ?? "laravel";
    const requestedStorage = options.storageLayout ?? "laravel";
    // The Strapi storage layout is inseparable from the Strapi API style: its controllers,
    // serializers and link-table writers are the strapi-api emitters. The CLI already rejects the
    // combination; this is the adapter-level guard, and it downgrades rather than throwing so a
    // misconfigured build still produces a working app plus a report saying what was ignored.
    const storage =
      requestedStorage === "strapi" && apiStyle !== "strapi" ? "laravel" : requestedStorage;
    const doc = normalize(ir.document);
    const draftPublish = draftPublishPlan(doc, apiStyle, storage);
    const versioned = draftPublish.versioned;
    const localization = localizationPlan(doc, apiStyle, storage);
    const localized = localization.localized;
    const media = mediaPlan({ ...ir, document: doc }, apiStyle, storage);
    const fileModel = media.file === undefined ? undefined : filamentNames(media.file).model;
    const { guests, gaps: guestGaps } = guestsPlan(ir.roles, apiStyle, storage);
    const rel = resolveRelations(
      doc,
      versioned,
      localized,
      apiStyle === "strapi" && storage !== "strapi",
    );
    const hooks = emitHookFiles(doc);
    const routeHooks = emitRouteHookFiles(doc, apiStyle === "strapi");
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [
      ...draftPublish.gaps,
      ...localization.gaps,
      ...media.gaps,
      ...guestGaps,
      // The Strapi API style keeps private fields out of its answers; the Laravel one cannot.
      ...(apiStyle === "strapi" ? [] : privateFieldGaps(doc, "the Laravel API style")),
    ];
    if (storage !== requestedStorage) {
      gaps.push({
        feature: "storageLayoutRequiresStrapiApi",
        location: {},
        severity: "error",
        message:
          'storageLayout "strapi" requires apiStyle "strapi"; the laravel storage layout was ' +
          "generated instead.",
      });
    }

    const aiObservedModels = new Set<string>();
    const aiGenFiles: GeneratedFile[] = [];
    const aiGaps: CapabilityGap[] = [];
    if (hasAiField(doc)) {
      aiGenFiles.push(aiProviderFile());
      for (const ct of aiFieldContentTypes(doc)) {
        if (hooks.observedModels.has(ct.name)) {
          aiGaps.push({
            feature: "aiHookCollision",
            location: { contentType: ct.name },
            severity: "downgrade",
            message: `"${ct.name}" has both a hook and an AI field; both target the model observer. The hook observer wins; AI generation is not wired for this type.`,
          });
          continue;
        }
        aiObservedModels.add(ct.name);
        aiGenFiles.push({
          path: `app/Observers/${filamentNames(ct).model}Observer.php`,
          content: emitAiObserver(ct),
        });
      }
    }

    // Builtin content types (the target's native user model) map onto the stock Laravel
    // User/users table; the host app owns those files, so nothing is emitted for them.
    const emitted = doc.contentTypes.filter((ct) => ct.builtin === undefined);
    // The Strapi storage layout emits no migrations (`emitStrapiStorage` owns its own schema),
    // so ordering create-table migrations only matters on the laravel storage layout.
    const { order: migrationTypeOrder, deferred } =
      storage === "strapi" ? { order: emitted, deferred: [] } : migrationOrder(doc, emitted);
    const isDeferred = (owner: string, key: ForeignKeyColumn): boolean =>
      deferred.some((d) => d.table === owner && d.references === key.references);
    const migrationOrdinal = new Map(migrationTypeOrder.map((ct, i) => [ct.name, i + 1]));
    // The Strapi storage layout emits its own models, so the observer registration that
    // `emitModel` writes on the Laravel layout has to travel with the input; `emitStrapiApi`
    // ignores it, because on that layout `emitModel` still owns the model.
    // The Filament admin is laid out as Strapi's wherever it serves Strapi's API over its own tables.
    const contentManager =
      apiStyle === "strapi" && storage !== "strapi"
        ? contentManagerSorts([
            ...emitted.map((ct) => strapiNames(ct).displayName),
            USER_DISPLAY_NAME,
          ])
        : undefined;
    const strapiInput = {
      doc,
      contentManager,
      bundle: ir,
      emitted,
      fkNames: rel.fkNames,
      versioned,
      localized,
      media: media.file,
      alwaysPopulateComponents: options.alwaysPopulateComponents === true,
      graphql: options.graphql === true,
      documentation: options.documentation === true,
      projectName: options.projectName,
      guests,
      observedModels: new Set([...hooks.observedModels, ...aiObservedModels]),
      routeHooked: routeHooks.hooked,
    };
    if (options.graphql === true && (apiStyle !== "strapi" || storage === "strapi")) {
      gaps.push({
        feature: "graphql",
        location: {},
        severity: "downgrade",
        message:
          "GraphQL is served on the Strapi API style over Laravel storage only; this project generates none.",
      });
    }
    if (options.documentation === true && (apiStyle !== "strapi" || storage === "strapi")) {
      gaps.push({
        feature: "documentation",
        location: {},
        severity: "downgrade",
        message:
          "The OpenAPI document and /documentation are served on the Strapi API style over Laravel storage only; this project generates neither.",
      });
    }
    const strapi =
      apiStyle === "strapi"
        ? storage === "strapi"
          ? emitStrapiStorage(strapiInput)
          : emitStrapiApi(strapiInput)
        : undefined;
    const children: { ct: (typeof emitted)[number]; child: ChildTableEmit }[] = [];
    const componentPivots: ComponentPivot[] = [];
    // Constraints on an entry's own component relation keys, added once every table exists.
    const componentKeys = new Map<string, ForeignKeyColumn[]>();
    // The Strapi API style over Laravel storage keeps what Strapi's components hold all the way
    // down: relations inside them, and repeatables inside their items.
    const deepComponents = apiStyle === "strapi" && storage !== "strapi";
    emitted.forEach((ct) => {
      for (const f of ct.fields) {
        if (f.type === "relation" || f.type === "component") continue;
        // The Strapi API style keeps a dynamic zone as one child table per member component.
        if (f.type === "dynamicZone" && apiStyle === "strapi") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Filament target`,
          });
        }
      }
      const expansion = expandComponents(
        doc,
        ct,
        deepComponents ? { componentRelations: true, nestedTables: true } : {},
      );
      gaps.push(...expansion.gaps);
      // On the Strapi storage layout the schema, the admin panel and the models are Strapi's:
      // `emitStrapiStorage` owns every per-content-type file, so nothing below applies.
      if (storage === "strapi") return;
      // A shared embedded column is NOT NULL only when the component is always present;
      // `s.field.required` alone still speaks for validation, not for the column.
      // With a media library an embedded component's media field is a link from the entry, by its
      // path, not a column.
      const embeddedMedia = expansion.scalars.filter(
        (s) => fileModel !== undefined && s.field.type === "media",
      );
      const embeddedEmits = expansion.scalars
        .filter((s) => !embeddedMedia.includes(s))
        .map((s) => emitField(columnField(s), s.path.map(snakeColumn).join("_")));
      const context = deepComponents ? { doc } : undefined;
      const ctChildren = expansion.tables.map((t) =>
        childTableEmit(ct, t, fileModel !== undefined, context),
      );
      const zoneChildren =
        apiStyle === "strapi"
          ? expansion.zones.flatMap((z) =>
              z.members.map(
                (m): ChildTableEmit => ({
                  ...childTableEmit(ct, m.table, fileModel !== undefined, context),
                  ordered: true,
                }),
              ),
            )
          : [];
      const allChildren = [...ctChildren, ...zoneChildren].flatMap(childTablesWithin);
      allChildren.forEach((child) => children.push({ ct, child }));
      const names = filamentNames(ct);
      const ownRelations = deepComponents
        ? componentRelations(doc, names.table, `${snake(ct.name)}_id`, expansion.relations)
        : [];
      componentPivots.push(
        ...[...allChildren.flatMap((c) => c.relations), ...ownRelations].flatMap((r) =>
          r.pivot === null ? [] : [r.pivot],
        ),
      );
      const ownKeys = ownRelations.flatMap((r) => (r.foreignKey === null ? [] : [r.foreignKey]));
      if (ownKeys.length > 0) componentKeys.set(ct.name, ownKeys);
      const pickers = relationPickers(ct, versioned, localized);
      const linkOrders = strapi?.linkOrders?.get(ct.name);
      // With a media library a media field is a link to its files, not a column; a dynamic zone
      // lives in its members' tables.
      const mediaOf = fileModel === undefined ? [] : mediaFields(ct);
      const mediaItems = [...ctChildren, ...zoneChildren]
        .filter(linksFilesWithin)
        .map((c) => c.relationName);
      const columns = {
        ...ct,
        fields: ct.fields.filter(
          (f) =>
            !(f.type === "media" && mediaOf.length > 0) &&
            !(f.type === "dynamicZone" && apiStyle === "strapi"),
        ),
      };
      files.push({
        path: `app/Models/${names.model}.php`,
        content: emitModel(
          columns,
          [
            ...(rel.methods.get(ct.name) ?? []),
            ...[...ctChildren, ...zoneChildren].map(childRelationMethod),
            ...ownRelations.map(componentRelationMethod),
          ],
          hooks.observedModels.has(ct.name) || aiObservedModels.has(ct.name),
          embeddedEmits,
          [...(rel.fkNames.get(ct.name) ?? []), ...ownKeys.map((k) => k.column)],
          strapi?.scopeMethods.get(ct.name) !== undefined
            ? [strapi.scopeMethods.get(ct.name)!]
            : [],
          [
            ...(apiStyle === "strapi"
              ? [
                  "App\\Models\\Concerns\\EmitsStrapiEvents",
                  "App\\Models\\Concerns\\HasDocumentId",
                  "App\\Models\\Concerns\\HasCreatorFields",
                ]
              : []),
            ...(versioned.has(ct.name) ? ["App\\Models\\Concerns\\HasDraftAndPublish"] : []),
            ...(localized.has(ct.name) ? ["App\\Models\\Concerns\\HasLocale"] : []),
            ...(mediaOf.length > 0 || mediaItems.length > 0 || embeddedMedia.length > 0
              ? ["App\\Models\\Concerns\\HasMedia"]
              : []),
            ...(linkOrders === undefined ? [] : ["App\\Models\\Concerns\\HasLinkOrder"]),
          ],
          [
            ...(linkOrders === undefined ? [] : [linkOrdersConstant(linkOrders)]),
            ...(localized.has(ct.name) ? [sharedAcrossLocalesMethod(ct)] : []),
            ...mediaOf.map((f) => mediaRelationMethod(f.name, f.name, fileModel)),
            ...embeddedMedia.map((s) =>
              mediaRelationMethod(s.path.join("."), camelPath(s.path), fileModel),
            ),
            ...(mediaItems.length > 0 ? [mediaComponentsConstant(mediaItems)] : []),
          ],
        ),
      });
      files.push({
        path: migrationFilename(ct, migrationOrdinal.get(ct.name)!),
        content: emitMigration(
          columns,
          [
            ...(rel.fkColumns.get(ct.name) ?? []).map((k) =>
              isDeferred(ct.name, k) ? k.definition : constrainedColumn(k),
            ),
            // Constrained once every table exists: the target's may come later.
            ...ownKeys.map((k) => k.definition),
          ],
          embeddedEmits,
          {
            documentId: apiStyle === "strapi",
            draftPublish: versioned.has(ct.name),
            localized: localized.has(ct.name),
            creatorFields: apiStyle === "strapi",
          },
        ),
      });
      files.push(
        ...emitResourceFiles(
          columns,
          [
            ...(rel.formFields.get(ct.name) ?? []),
            ...ownRelations.map((r) =>
              componentRelationPicker(r, versioned, localized, pickers.locale(0)),
            ),
          ],
          embeddedEmits,
          [
            ...ctChildren.map((c) => repeaterComponent(c, pickers)),
            ...(apiStyle === "strapi"
              ? expansion.zones.map((z) =>
                  zoneBuilder(ct, z, fileModel !== undefined, context, pickers),
                )
              : []),
          ],
          {
            versioned: versioned.has(ct.name),
            localized: localized.has(ct.name),
            secured: ir.roles.length > 0,
            adminScoped: strapi?.adminScoped?.has(ct.name) === true,
            media: [
              ...mediaOf.map((f) => ({
                field: f.name,
                multiple: f.multiple === true,
                ...mediaAllowedTypes(f),
              })),
              ...embeddedMedia.map((s) => ({
                field: camelPath(s.path),
                multiple: s.field.type === "media" && s.field.multiple === true,
                ...mediaAllowedTypes(s.field),
                attribute: s.path[0]!,
              })),
            ],
            ...(contentManager === undefined
              ? {}
              : {
                  contentManager: {
                    fields: ct.fields,
                    relations: rel.adminRelations.get(ct.name) ?? [],
                    componentRelationAttributes: ownRelations.map((r) => r.path[0]!),
                    extraAttributes: expansion.scalars
                      .filter((s) => !embeddedMedia.includes(s))
                      .map((s) => s.path[0]!),
                    repeaterAttributes: [
                      ...expansion.tables.map((t) => t.path[0]!),
                      ...(apiStyle === "strapi" ? expansion.zones.map((z) => z.name) : []),
                    ],
                    prohibited: prohibitedCloningFields(doc, ct),
                  },
                }),
            ...(contentManager === undefined
              ? {}
              : {
                  navigation: {
                    group: ct.kind === "single" ? "SingleTypes" : "CollectionTypes",
                    label: strapiNames(ct).displayName,
                    sort: contentManager.get(strapiNames(ct).displayName)!,
                  },
                }),
          },
        ),
      );
      allChildren.forEach((child) => {
        files.push({
          path: `app/Models/${child.model}.php`,
          content: emitChildModel(child, fileModel),
        });
      });
      if (apiStyle === "laravel") {
        files.push({
          path: `app/Http/Controllers/Api/${names.model}ApiController.php`,
          content: emitApiController(
            ct,
            [
              ...ct.fields
                .filter((f) => f.type !== "relation" && f.type !== "component")
                .map((f) => emitField(f).column),
              ...embeddedEmits.map((e) => e.column),
              ...(rel.fkNames.get(ct.name) ?? []),
            ],
            { secured: ir.roles.length > 0 },
          ),
        });
      }
    });

    if (strapi) {
      files.push(...strapi.files);
      gaps.push(...strapi.gaps);
    } else {
      files.push({
        path: "routes/api.php",
        content: emitApiRoutes(emitted, {
          secured: ir.roles.length > 0,
          hooked: routeHooks.hooked,
        }),
      });
    }
    files.push(apiCustomSeed());
    // Edited in the admin, which the Strapi storage layout does not have.
    if (storage !== "strapi" && hasBlocksFields(doc)) {
      files.push(...emitBlocksFiles(fileModel !== undefined));
    }
    if (storage !== "strapi" && hasJsonFields(doc)) files.push(...emitJsonEditorFiles());
    if (storage !== "strapi") {
      const admin = emitAdminAccessFiles(ir.roles);
      files.push(...admin.files);
      gaps.push(...admin.gaps);
    }

    // Pivot and child tables are Strapi's `_lnk` and component tables on the Strapi layout, so
    // there is nothing here to migrate.
    if (storage !== "strapi") {
      [...rel.pivots]
        .sort((a, b) => a.table.localeCompare(b.table))
        .forEach((p, j) => {
          files.push({
            path: pivotMigrationFilename(p, emitted.length + 1 + j),
            content: emitPivotMigration(p),
          });
        });

      [...children]
        .sort((a, b) => a.child.table.localeCompare(b.child.table))
        .forEach(({ child }, k) => {
          files.push({
            path: childMigrationFilename(child, emitted.length + rel.pivots.length + 1 + k),
            content: emitChildMigration(child),
          });
        });

      // After the child tables, which a link from an item's component names.
      const afterChildren = emitted.length + rel.pivots.length + children.length;
      [...componentPivots]
        .sort((a, b) => a.table.localeCompare(b.table))
        .forEach((p, k) => {
          files.push({
            path: componentPivotMigrationFilename(p, afterChildren + 1 + k),
            content: emitComponentPivotMigration(p),
          });
        });

      const afterTables = afterChildren + componentPivots.length;
      migrationTypeOrder
        .map((ct) => ({
          ct,
          keys: [
            ...(rel.fkColumns.get(ct.name) ?? []).filter((k) => isDeferred(ct.name, k)),
            ...(componentKeys.get(ct.name) ?? []),
          ],
        }))
        .filter(({ keys }) => keys.length > 0)
        .forEach(({ ct, keys }, i) => {
          files.push({
            path: foreignKeysMigrationFilename(ct, afterTables + 1 + i),
            content: emitForeignKeysMigration(ct, keys),
          });
        });
    }

    const perm = emitPermissions(
      doc,
      ir.roles,
      storage,
      guests,
      apiStyle === "strapi" && storage !== "strapi",
    );
    const allFiles = [
      ...files,
      ...hooks.files,
      ...routeHooks.files,
      ...emitScheduleFiles(doc),
      ...perm.files,
      ...aiGenFiles,
      deployFile(storage, {
        graphql: options.graphql === true && apiStyle === "strapi" && storage !== "strapi",
        documentation:
          options.documentation === true && apiStyle === "strapi" && storage !== "strapi",
        transfer: apiStyle === "strapi" && storage !== "strapi",
        schedules: (doc.schedules ?? []).length > 0,
      }),
    ];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "filament", gaps: [...gaps, ...perm.gaps, ...aiGaps] },
    };
  },
};
