import { z } from "zod";

export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

export const typeName = z.string().regex(TYPE_NAME_PATTERN, "must be PascalCase");
export const fieldName = z.string().regex(FIELD_NAME_PATTERN, "must be camelCase");
