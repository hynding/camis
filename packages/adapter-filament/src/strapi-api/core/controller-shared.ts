import { fieldApiName, type ContentType } from "@camis/ir-schema";
import { phpSingleQuoted } from "../../php-literal";

/**
 * Indent levels and the authorize-line helper shared by the two controller layouts. They live
 * apart from `controller.ts` so the Strapi-storage half can use them without importing back into
 * the module that imports it — a runtime import cycle rather than a type-only one.
 */

// PSR-12 indent levels inside a method body.
export const STMT = "        "; // 8 spaces: a top-level statement in a method body
export const NESTED_STMT = "            "; // 12 spaces: a statement inside a method-body if-block

/**
 * `indent` lets a single call site emit at whatever nesting depth it sits in (the update()
 * create branch and the update() if-block sit one level apart).
 */
export const authLine =
  (secured: boolean) =>
  (line: string, indent: string = STMT): string =>
    secured ? `${indent}${line}\n` : "";

/** What the create checks read of a controller's spec. */
interface CheckedSpec {
  ct: ContentType;
  secured: boolean;
  shape: { model: string };
}

/** What the validator call reads of a controller's spec. */
interface ValidatedSpec {
  rules?: string;
  unique?: boolean;
  shape: { draftPublish: boolean };
}

/**
 * Strapi's entity validator, before anything is written: a draft is checked as Strapi checks one,
 * an update that creates a locale the document lacks as a creation, and a unique value against
 * the other entries (`others()`), the one written (`key`) left out.
 */
export const validate = (
  spec: ValidatedSpec,
  creating: string,
  indent: string = STMT,
  given = "",
  key = "null",
): string =>
  spec.rules === undefined
    ? ""
    : `${indent}StrapiValidator::validate($request->input('data'), self::RULES, creating: ${creating}${
        spec.shape.draftPublish ? ", draft: StrapiDocuments::draftOnly($request->query())" : ""
      }${given}${spec.unique === true ? `, unique: fn (): Builder => $this->others($request, ${key})` : ""});\n`;

// Strapi's single type has no create action: its update grant makes the one entry, so the check
// waits for the new row, which a grant's condition reads.
export const createCheck = (spec: CheckedSpec): string =>
  spec.ct.kind === "single"
    ? ""
    : authLine(spec.secured)(`$this->authorize('create', ${spec.shape.model}::class);`);
export const madeCheck = (spec: CheckedSpec): string =>
  spec.ct.kind === "single" ? authLine(spec.secured)(`$this->authorize('update', $m);`) : "";

/** A put that creates its row takes the upsert key from the route, as a field it need not send. */
export const routeKey = (ct: ContentType): string => {
  const field = ct.fields.find((f) => f.name === ct.options?.upsertBy);
  return field === undefined ? "" : `, given: [${phpSingleQuoted(fieldApiName(field))} => $key]`;
};
