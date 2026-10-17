import type { ApiStyle, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

export interface DraftPublishPlan {
  /** Content types stored as Strapi 5 documents: a draft row and, once published, a second one. */
  versioned: ReadonlySet<string>;
  gaps: CapabilityGap[];
}

/**
 * Which `draftPublish` content types get Strapi 5's two-row document model: those on the Strapi API
 * style over the laravel storage layout (the Strapi storage layout reports its own gap). Every
 * case that cannot hold two rows per document is reported rather than silently dropped.
 */
export const draftPublishPlan = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: StorageLayout,
): DraftPublishPlan => {
  const versioned = new Set<string>();
  const gaps: CapabilityGap[] = [];
  if (storage === "strapi") return { versioned, gaps };
  for (const ct of doc.contentTypes) {
    if (ct.options?.draftPublish !== true || ct.builtin !== undefined) continue;
    const drop = (message: string): void => {
      gaps.push({
        feature: "draftPublish",
        location: { contentType: ct.name },
        severity: "downgrade",
        message,
      });
    };
    if (apiStyle !== "strapi") {
      drop(
        `"${ct.name}" enables draftPublish; the Laravel API style keeps one row per record, so there is no separate draft`,
      );
      continue;
    }
    if (ct.options.upsertBy !== undefined) {
      drop(
        `"${ct.name}" enables draftPublish with upsertBy "${ct.options.upsertBy}", which must be unique per row; draft and publish is not generated`,
      );
      continue;
    }
    if (ct.fields.some((f) => f.name === "publishedAt")) {
      drop(
        `"${ct.name}" enables draftPublish but declares its own publishedAt field; draft and publish is not generated`,
      );
      continue;
    }
    versioned.add(ct.name);
    for (const f of ct.fields) {
      if ("unique" in f && f.unique === true) {
        gaps.push({
          feature: "draftPublish",
          location: { contentType: ct.name, field: f.name },
          severity: "downgrade",
          message: `"${ct.name}.${f.name}" is unique, but a draft and its published version share the value, so the database does not enforce it`,
        });
      }
    }
  }
  return { versioned, gaps };
};
