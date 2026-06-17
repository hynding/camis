import type { z } from "zod";
import { irDocument } from "./document";
import {
  fail,
  ok,
  type IrError,
  type IrErrorCode,
  type IrErrorLocation,
  type Result,
} from "./errors";

const codeFromIssue = (issue: z.ZodIssue): IrErrorCode => {
  const params = (issue as { params?: { irCode?: IrErrorCode } }).params;
  if (params?.irCode) return params.irCode;
  if (issue.code === "invalid_string") return "invalid_identifier";
  if (issue.code === "too_small" && issue.path.at(-1) === "values") return "empty_enumeration";
  if (issue.code === "too_small" && issue.path.at(-1) === "components") return "empty_dynamic_zone";
  if (issue.code === "invalid_type" && issue.path.at(-1) === "default")
    return "invalid_default_type";
  return "invalid_document";
};

const locationFromPath = (input: unknown, path: (string | number)[]): IrErrorLocation => {
  const loc: IrErrorLocation = {};
  let node: unknown = input;
  let prevKey: string | number | undefined;
  for (const key of path) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string | number, unknown>)[key];
    if (Array.isArray(node)) {
      prevKey = key;
      continue;
    }
    if (node && typeof node === "object") {
      const named = node as { name?: unknown };
      if (typeof named.name === "string") {
        if (prevKey === "contentTypes") loc.contentType = named.name;
        else if (prevKey === "components") loc.component = named.name;
        else if (prevKey === "fields") loc.field = named.name;
      }
    }
    prevKey = key;
  }
  return loc;
};

const byPath = (a: IrError, b: IrError) =>
  JSON.stringify(a.path).localeCompare(JSON.stringify(b.path));

export const parseDocument = (input: unknown): Result<z.infer<typeof irDocument>> => {
  const r = irDocument.safeParse(input);
  if (r.success) return ok(r.data);
  const errors: IrError[] = r.error.issues
    .map((issue) => ({
      code: codeFromIssue(issue),
      message: issue.message,
      location: locationFromPath(input, issue.path),
      path: [...issue.path],
    }))
    .sort(byPath);
  return fail(errors);
};
