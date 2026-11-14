import type { GeneratedFile } from "@camis/adapter-kernel";
import type { Field, IrDocument } from "@camis/ir-schema";
import { readFileSync } from "node:fs";
import { runtimePhp } from "./runtime-php";

export const CUSTOM_FIELDS_PATH = "app/Support/CustomFields.php";
/** The project's own registrations: hand-written, seeded once and never overwritten. */
export const CUSTOM_FIELD_REGISTRATIONS_PATH = "app/CustomFields/Registrations.php";

const hasEditor = (fields: readonly Field[]): boolean => fields.some((f) => f.editor !== undefined);

/**
 * Strapi's custom fields registry and the project's registrations: wherever the Content-Type
 * Builder may add one (the Strapi API style) or a field already names one.
 */
export const emitCustomFields = (doc: IrDocument, builder: boolean): GeneratedFile[] =>
  builder ||
  doc.contentTypes.some((ct) => hasEditor(ct.fields)) ||
  doc.components.some((c) => hasEditor(c.fields))
    ? [
        {
          path: CUSTOM_FIELDS_PATH,
          content: runtimePhp(
            new URL(`./strapi-api/core/php/${CUSTOM_FIELDS_PATH}`, import.meta.url),
          ),
        },
        {
          path: CUSTOM_FIELD_REGISTRATIONS_PATH,
          // Hand-written once seeded, so without the generated marker.
          content: readFileSync(
            new URL(`./strapi-api/core/php/${CUSTOM_FIELD_REGISTRATIONS_PATH}`, import.meta.url),
            "utf8",
          ),
          mode: "seed",
        },
      ]
    : [];
