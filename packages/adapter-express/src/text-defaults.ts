import type {
  CapabilityGap,
  ComponentFieldT,
  Field,
  IrDocument,
  IrErrorLocation,
} from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { isMysqlText, isSupportedField } from "./fields";

const message = (field: string): string =>
  `"${field}" has a default, and its MySQL column is a text, which takes no default; Drizzle applies the default when it inserts a row, not the database, so a row inserted without Drizzle gets none`;

/**
 * Each default Drizzle applies rather than the database, located: on MySQL, a default on a text
 * type. PostgreSQL's and SQLite's text take a default.
 */
export const expressTextDefaultGaps = (doc: IrDocument, dialect: Dialect): CapabilityGap[] => {
  if (dialect !== "mysql") return [];
  const located = (holder: IrErrorLocation, fields: readonly (Field | ComponentFieldT)[]) =>
    fields.flatMap((field): CapabilityGap[] =>
      "default" in field &&
      field.default !== undefined &&
      isSupportedField(field.type) &&
      isMysqlText(field as Field)
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
