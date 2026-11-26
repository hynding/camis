import { holdsTextColumn, type StorageLayout } from "@camis/adapter-kernel";
import type {
  CapabilityGap,
  ComponentFieldT,
  Field,
  IrDocument,
  IrErrorLocation,
} from "@camis/ir-schema";

const message = (field: string): string =>
  `"${field}" has a default, and its column is a text column, which MySQL gives no default; the model applies the default when it creates a row, not the database, so a row inserted without the model gets none`;

/**
 * Each default the model applies rather than the database (`FieldEmit.modelDefault`), located. On
 * Strapi's storage layout no migration of ours makes the columns: Strapi made them, and its API
 * style applies defaults as Strapi's does.
 */
export const filamentTextDefaultGaps = (
  doc: IrDocument,
  storage: StorageLayout,
): CapabilityGap[] => {
  if (storage === "strapi") return [];
  const located = (holder: IrErrorLocation, fields: readonly (Field | ComponentFieldT)[]) =>
    fields.flatMap((field): CapabilityGap[] =>
      "default" in field && field.default !== undefined && holdsTextColumn(field)
        ? [
            {
              feature: "textDefault",
              location: { ...holder, field: field.name },
              severity: "downgrade",
              message: message(field.name),
            },
          ]
        : [],
    );
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};
