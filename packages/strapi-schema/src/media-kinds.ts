import type { Field } from "@camis/ir-schema";

type MediaKind = NonNullable<Extract<Field, { type: "media" }>["allowedTypes"]>[number];

// Strapi's content-type builder names media kinds in the plural; the IR uses the singular.
const STRAPI_MEDIA_KIND: Record<MediaKind, string> = {
  image: "images",
  video: "videos",
  audio: "audios",
  file: "files",
};

const IR_MEDIA_KIND: Record<string, MediaKind> = Object.fromEntries(
  Object.entries(STRAPI_MEDIA_KIND).map(([ir, strapi]) => [strapi, ir as MediaKind]),
);

export const toStrapiMediaKinds = (kinds: readonly MediaKind[]): string[] =>
  kinds.map((kind) => STRAPI_MEDIA_KIND[kind]);

/**
 * Unknown kinds pass through unchanged so IR validation reports them against the field, and the
 * singular form is accepted because the emitter wrote it before it learned Strapi's plural.
 */
export const fromStrapiMediaKinds = (kinds: readonly unknown[]): unknown[] =>
  kinds.map((kind) => (typeof kind === "string" ? (IR_MEDIA_KIND[kind] ?? kind) : kind));
