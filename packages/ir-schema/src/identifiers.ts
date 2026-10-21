import { z } from "zod";

export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
/**
 * A physical name: a database table, a Strapi component category directory, and the `<group>`
 * half of a `<group>.<name>` component uid. Constrained to lowercase alphanumerics with `_`/`-`
 * separators, because anything else either cannot be a table name on every supported driver or
 * silently renames itself in one of the places it is reused.
 */
/**
 * The key a field goes by on an API that already exists (an imported Strapi project's snake_case
 * attributes): an identifier every target can use as an object key and a query parameter path.
 */
export const API_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const typeName = z.string().regex(TYPE_NAME_PATTERN, "must be PascalCase");
export const fieldName = z.string().regex(FIELD_NAME_PATTERN, "must be camelCase");
export const apiName = z
  .string()
  .regex(API_NAME_PATTERN, "must be an identifier ([A-Za-z_][A-Za-z0-9_]*)");
export const collectionName = z
  .string()
  .regex(COLLECTION_NAME_PATTERN, "must be a lowercase identifier ([a-z0-9][a-z0-9_-]*)");
