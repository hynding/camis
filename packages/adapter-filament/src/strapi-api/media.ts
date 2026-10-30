import { expandComponents, type ApiStyle, type StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, Field, IrDocument } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";

/** The media library a document's media fields use when it declares no builtin file type. */
const IMPLICIT_FILE: ContentType = {
  name: "File",
  kind: "collection",
  builtin: "file",
  fields: [],
};

export const mediaFields = (ct: ContentType) => ct.fields.filter((f) => f.type === "media");

const MEDIA_KINDS = ["image", "video", "audio", "file"] as const;

/** A media field's allowedTypes, in a stable order; none when it takes every kind, as Strapi reads it. */
export const mediaAllowedTypes = (field: Field): { allowedTypes?: string[] } => {
  if (field.type !== "media" || field.allowedTypes === undefined) return {};
  const kinds = MEDIA_KINDS.filter((kind) => field.allowedTypes?.includes(kind));
  return kinds.length === MEDIA_KINDS.length ? {} : { allowedTypes: kinds };
};

export interface MediaPlan {
  /** The builtin file type, declared or implied by a media field; undefined without a library. */
  file: ContentType | undefined;
  gaps: CapabilityGap[];
}

/**
 * Whether the project has a media library, and its type. Only the Strapi API style on the laravel
 * storage layout keeps one: the Laravel API style stores a media field as a path column, and the
 * Strapi storage layout reports media as a gap of its own. Under roles, a library no grant opens
 * is reported: nobody could upload, list or link its files through the API.
 */
export const mediaPlan = (
  bundle: IrBundle,
  apiStyle: ApiStyle,
  storage: StorageLayout,
): MediaPlan => {
  const doc: IrDocument = bundle.document;
  if (apiStyle !== "strapi" || storage === "strapi") return { file: undefined, gaps: [] };
  const declared = doc.contentTypes.find((ct) => ct.builtin === "file");
  const used = doc.contentTypes.some(
    (ct) => ct.builtin === undefined && mediaFields(ct).length > 0,
  );
  if (declared === undefined && !used) return { file: undefined, gaps: [] };
  const file = declared ?? IMPLICIT_FILE;
  const granted = bundle.roles.some((r) => r.grants.some((g) => g.contentType === file.name));
  const gaps: CapabilityGap[] =
    bundle.roles.length > 0 && !granted
      ? [
          {
            feature: "media",
            location: { contentType: file.name },
            severity: "downgrade",
            message: `no role is granted the media library${declared === undefined ? ` (declare a content type with builtin: "file" to grant it)` : ` ("${file.name}")`}, so its files cannot be uploaded or listed through the API (entries still read and link their media, as on Strapi)`,
          },
        ]
      : [];
  return { file, gaps };
};

/** The repeatable components whose items link files, which go with the entry, links and all. */
export const mediaComponentsConstant = (relations: readonly string[]): string =>
  `    public const MEDIA_COMPONENTS = [${relations.map((r) => `'${r}'`).join(", ")}];`;

/**
 * Media fields that stay path columns although the project keeps a media library: those of an
 * embedded component (its fields are columns of the entry's own row) and of a dynamic zone's item.
 */
export const columnMediaGaps = (
  ct: ContentType,
  expansion: ReturnType<typeof expandComponents>,
): CapabilityGap[] =>
  [
    ...expansion.scalars.map((s) => ({ s, where: "an embedded component" })),
    ...expansion.zones.flatMap((z) =>
      z.members.flatMap((m) => m.table.scalars.map((s) => ({ s, where: "a dynamic zone's item" }))),
    ),
  ]
    .filter(({ s }) => s.field.type === "media")
    .map(({ s, where }) => ({
      feature: "componentMedia",
      location: { contentType: ct.name, field: s.apiPath.join(".") },
      severity: "downgrade" as const,
      message: `a media field inside ${where} is stored as a file path, not linked to the media library`,
    }));

/** strapi:export and strapi:import carry an entry's own files, not those its components' items link. */
export const itemMediaTransferGap = (
  ct: ContentType,
  relations: readonly string[],
): CapabilityGap => ({
  feature: "componentMediaTransfer",
  location: { contentType: ct.name },
  severity: "downgrade",
  message: `strapi:export and strapi:import leave out the files linked from the items of ${relations.join(", ")}; relink them after an import`,
});
