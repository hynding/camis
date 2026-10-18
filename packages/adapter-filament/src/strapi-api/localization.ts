import type { ApiStyle, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import { snakeColumn } from "../names";

export interface LocalizationPlan {
  /** Content types stored as Strapi 5 documents with one row per locale. */
  localized: ReadonlySet<string>;
  gaps: CapabilityGap[];
}

/**
 * Which `localized` content types get Strapi 5's row-per-locale model: those on the Strapi API
 * style over the laravel storage layout (the Strapi storage layout reports its own gap). Every
 * case the model cannot hold is reported rather than silently dropped.
 */
export const localizationPlan = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: StorageLayout,
): LocalizationPlan => {
  const localized = new Set<string>();
  const gaps: CapabilityGap[] = [];
  if (storage === "strapi") return { localized, gaps };
  for (const ct of doc.contentTypes) {
    if (ct.options?.localized !== true || ct.builtin !== undefined) continue;
    const gap = (message: string, field?: string): void => {
      gaps.push({
        feature: "localized",
        location: field === undefined ? { contentType: ct.name } : { contentType: ct.name, field },
        severity: "downgrade",
        message,
      });
    };
    if (apiStyle !== "strapi") {
      gap(
        `"${ct.name}" is localized; the Laravel API style keeps one row per record, in no locale`,
      );
      continue;
    }
    if (ct.options.upsertBy !== undefined) {
      gap(
        `"${ct.name}" is localized with upsertBy "${ct.options.upsertBy}", which must be unique per row; localization is not generated`,
      );
      continue;
    }
    localized.add(ct.name);
    for (const f of ct.fields) {
      if ("unique" in f && f.unique === true) {
        gap(
          `"${ct.name}.${f.name}" is unique, but the locales of a document are rows of one table, so the database does not enforce it`,
          f.name,
        );
      }
      if ((f.type === "relation" || f.type === "component") && f.localized === false) {
        gap(
          `"${ct.name}.${f.name}" is marked as shared by every locale; ${f.type === "relation" ? "relations" : "components"} are kept per locale`,
          f.name,
        );
      }
    }
  }
  return { localized, gaps };
};

/** The model method `HasLocale` reads: the columns of the fields every locale shares. */
export const sharedAcrossLocalesMethod = (ct: ContentType): string => {
  const columns = ct.fields
    .filter((f) => f.type !== "relation" && f.type !== "component" && f.localized === false)
    .map((f) => `'${snakeColumn(f.name)}'`);
  return `    /** @return list<string> */\n    public function sharedAcrossLocales(): array\n    {\n        return [${columns.join(", ")}];\n    }`;
};
