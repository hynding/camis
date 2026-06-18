import { z } from "zod";
import { expression } from "@camis/expr";
import { fieldName, typeName } from "@camis/ir-schema";
import { action } from "./actions";

export const fieldRule = z.object({
  field: fieldName,
  access: z.enum(["read", "write"]),
  when: expression.optional(),
});
export type FieldRule = z.infer<typeof fieldRule>;

export const grant = z.object({
  contentType: typeName,
  actions: z.array(action).min(1),
  fieldRules: z.array(fieldRule).optional(),
  condition: expression.optional(),
});
export type Grant = z.infer<typeof grant>;

export const role = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  grants: z.array(grant),
});
export type Role = z.infer<typeof role>;
