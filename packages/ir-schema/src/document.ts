import { z } from "zod";
import { componentField, field, fieldApiName } from "./fields";
import { hook } from "./hooks";
import { collectionName, fieldName, typeName } from "./identifiers";

const RESERVED_FIELD_NAMES = new Set(["id"]);

type RefinedField = {
  name: string;
  type: string;
  targetField?: string;
  names?: { api?: string | undefined } | undefined;
};

const nodeRefine = (fields: RefinedField[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  const keys = new Set<string>();
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
    // A field's API key must be as unique as its name, or one would shadow the other on the wire.
    const key = fieldApiName(f);
    if (key !== f.name && (keys.has(key) || fields.some((g) => g !== f && g.name === key))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `field "${f.name}" goes by "${key}" on the API, which another field also does`,
        params: { irCode: "duplicate_field" },
        path: ["fields", i, "names", "api"],
      });
    }
    keys.add(key);
    if (RESERVED_FIELD_NAMES.has(key) && key !== f.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${key}" is a reserved field name`,
        params: { irCode: "reserved_field_name" },
        path: ["fields", i, "names", "api"],
      });
    }
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
    /** A type the target supplies: the users it authenticates, or the media library's files. */
    builtin: z.enum(["user", "file"]).optional(),
    names: z
      .object({
        plural: z.string().optional(),
        display: z.string().optional(),
        collection: collectionName.optional(),
      })
      .optional(),
    fields: z.array(field),
    options: z
      .object({
        draftPublish: z.boolean().optional(),
        timestamps: z.boolean().optional(),
        softDelete: z.boolean().optional(),
        upsertBy: fieldName.optional(),
        /** Each document keeps one version per locale. */
        localized: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((ct, ctx) => {
    nodeRefine(ct.fields as RefinedField[], ctx);
    if (ct.options?.localized === true) return;
    ct.fields.forEach((f, i) => {
      if ("localized" in f && f.localized !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `field "${f.name}" sets localized, but content type "${ct.name}" is not localized`,
          params: { irCode: "localized_field_without_localized_type" },
          path: ["fields", i, "localized"],
        });
      }
    });
  });

export const component = z
  .object({
    name: typeName,
    names: z
      .object({
        collection: collectionName.optional(),
        group: collectionName.optional(),
      })
      .optional(),
    fields: z.array(componentField),
  })
  .superRefine((c, ctx) => nodeRefine(c.fields as RefinedField[], ctx));

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
