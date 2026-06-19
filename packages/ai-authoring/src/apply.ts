import type { ContentType, IrDocument } from "@camis/ir-schema";
import type { AuthoringError, Mutation } from "./mutation";

export const applyMutations = (
  doc: IrDocument,
  ops: Mutation[],
): { document: IrDocument; errors: AuthoringError[] } => {
  const out: IrDocument = structuredClone(doc);
  const errors: AuthoringError[] = [];
  const ct = (name: string): ContentType | undefined =>
    out.contentTypes.find((c) => c.name === name);
  const fail = (message: string, location: AuthoringError["location"]): void => {
    errors.push({ code: "inapplicable_mutation", message, location, path: [] });
  };

  for (const op of ops) {
    switch (op.op) {
      case "addContentType":
        if (ct(op.contentType.name)) {
          fail(`content type "${op.contentType.name}" already exists`, {
            contentType: op.contentType.name,
          });
        } else {
          out.contentTypes.push(op.contentType);
        }
        break;
      case "removeContentType": {
        const i = out.contentTypes.findIndex((c) => c.name === op.name);
        if (i < 0) fail(`content type "${op.name}" does not exist`, { contentType: op.name });
        else out.contentTypes.splice(i, 1);
        break;
      }
      case "addField": {
        const target = ct(op.contentType);
        if (!target)
          fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
        else target.fields.push(op.field);
        break;
      }
      case "removeField": {
        const target = ct(op.contentType);
        if (!target) {
          fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
          break;
        }
        const i = target.fields.findIndex((f) => f.name === op.field);
        if (i < 0)
          fail(`field "${op.field}" does not exist on "${op.contentType}"`, {
            contentType: op.contentType,
            field: op.field,
          });
        else target.fields.splice(i, 1);
        break;
      }
      case "renameField": {
        const target = ct(op.contentType);
        if (!target) {
          fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
          break;
        }
        const f = target.fields.find((g) => g.name === op.from);
        if (!f)
          fail(`field "${op.from}" does not exist on "${op.contentType}"`, {
            contentType: op.contentType,
            field: op.from,
          });
        else f.name = op.to;
        break;
      }
    }
  }
  return { document: out, errors };
};
