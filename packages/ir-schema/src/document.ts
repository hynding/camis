import { z } from "zod";
import { componentField, field } from "./fields";
import { hook } from "./hooks";
import { typeName } from "./identifiers";

const RESERVED_FIELD_NAMES = new Set(["id"]);

const nodeRefine = (
  fields: { name: string; type: string; targetField?: string }[],
  ctx: z.RefinementCtx,
) => {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate field name "${f.name}"`,
        params: { irCode: "duplicate_field" },
        path: ["fields", i, "name"],
      });
    }
    seen.add(f.name);
    if (RESERVED_FIELD_NAMES.has(f.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${f.name}" is a reserved field name`,
        params: { irCode: "reserved_field_name" },
        path: ["fields", i, "name"],
      });
    }
  });
  fields.forEach((f, i) => {
    if (
      f.type === "uid" &&
      f.targetField !== undefined &&
      !fields.some((s) => s.name === f.targetField)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `uid targetField "${f.targetField}" does not exist`,
        params: { irCode: "unknown_uid_target" },
        path: ["fields", i, "targetField"],
      });
    }
  });
};

export const contentType = z
  .object({
    name: typeName,
    kind: z.enum(["collection", "single"]),
    names: z
      .object({
        plural: z.string().optional(),
        display: z.string().optional(),
        collection: z.string().optional(),
      })
      .optional(),
    fields: z.array(field),
    options: z
      .object({
        draftPublish: z.boolean().optional(),
        timestamps: z.boolean().optional(),
        softDelete: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((ct, ctx) =>
    nodeRefine(ct.fields as { name: string; type: string; targetField?: string }[], ctx),
  );

export const component = z
  .object({ name: typeName, fields: z.array(componentField) })
  .superRefine((c, ctx) =>
    nodeRefine(c.fields as { name: string; type: string; targetField?: string }[], ctx),
  );

export const irDocument = z
  .object({
    version: z.literal(1),
    contentTypes: z.array(contentType),
    components: z.array(component),
    hooks: z.array(hook).optional(),
  })
  .superRefine((doc, ctx) => {
    const names = new Set(doc.contentTypes.map((ct) => ct.name));
    const seen = new Set<string>();
    (doc.hooks ?? []).forEach((h, i) => {
      if (!names.has(h.contentType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `hook "${h.name}" references unknown content type "${h.contentType}"`,
          params: { irCode: "unknown_hook_content_type" },
          path: ["hooks", i, "contentType"],
        });
      }
      if (seen.has(h.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate hook name "${h.name}"`,
          params: { irCode: "duplicate_hook" },
          path: ["hooks", i, "name"],
        });
      }
      seen.add(h.name);
    });
  });

export type ContentType = z.infer<typeof contentType>;
export type Component = z.infer<typeof component>;
export type IrDocument = z.infer<typeof irDocument>;
