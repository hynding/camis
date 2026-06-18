import { z } from "zod";
import { fieldName, typeName } from "./identifiers";

export const HOOK_SCALARS = ["string", "text", "integer", "float", "boolean", "dateTime"] as const;
export type HookScalar = (typeof HOOK_SCALARS)[number];

export const shapeField = z.object({ name: fieldName, type: z.enum(HOOK_SCALARS) });
export type ShapeField = z.infer<typeof shapeField>;

export const hook = z.object({
  name: typeName,
  trigger: z.literal("onPublish"),
  contentType: typeName,
  input: z.array(shapeField).min(1),
  output: z.array(shapeField).min(1),
});
export type Hook = z.infer<typeof hook>;
