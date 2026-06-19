import { z } from "zod";
import {
  contentType,
  field,
  fieldName,
  typeName,
  type IrErrorCode,
  type IrErrorLocation,
} from "@camis/ir-schema";

export const mutation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addContentType"), contentType }),
  z.object({ op: z.literal("removeContentType"), name: typeName }),
  z.object({ op: z.literal("addField"), contentType: typeName, field }),
  z.object({ op: z.literal("removeField"), contentType: typeName, field: fieldName }),
  z.object({ op: z.literal("renameField"), contentType: typeName, from: fieldName, to: fieldName }),
]);
export type Mutation = z.infer<typeof mutation>;

export const mutations = z.array(mutation);

// IrError shape, widened so the applier's op-applicability errors coexist with ir-core's IrErrors
// WITHOUT adding an authoring concept to ir-schema's IrErrorCode.
export type AuthoringErrorCode = IrErrorCode | "inapplicable_mutation";
export interface AuthoringError {
  code: AuthoringErrorCode;
  message: string;
  location: IrErrorLocation;
  path: (string | number)[];
}
