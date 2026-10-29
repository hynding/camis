import type { ApiStyle, StorageLayout } from "@camis/adapter-kernel";
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
            message: `no role is granted the media library${declared === undefined ? ` (declare a content type with builtin: "file" to grant it)` : ` ("${file.name}")`}, so its files cannot be uploaded, listed or linked through the API`,
          },
        ]
      : [];
  return { file, gaps };
};
