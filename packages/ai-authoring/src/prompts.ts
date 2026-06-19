import { stableJson } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import type { AuthoringError, Mutation } from "./mutation";

export const buildSystemPrompt = (): string =>
  `You edit a content model by returning a JSON array of mutation ops (and nothing else).
Each op is one of:
- { "op": "addContentType", "contentType": <ContentType> }
- { "op": "removeContentType", "name": <TypeName> }
- { "op": "addField", "contentType": <TypeName>, "field": <Field> }
- { "op": "removeField", "contentType": <TypeName>, "field": <FieldName> }
- { "op": "renameField", "contentType": <TypeName>, "from": <FieldName>, "to": <FieldName> }
A ContentType is { "name", "kind": "collection"|"single", "fields": Field[] }.
A Field is { "type": <one of string|text|richText|email|uid|integer|bigInteger|float|decimal|boolean|enumeration|date|time|dateTime|timestamp|json|media|relation|component|dynamicZone>, "name", ... }.
TypeName is PascalCase; FieldName is camelCase. Return ONLY the JSON array of ops.`;

export const buildUserPrompt = (doc: IrDocument, instruction: string): string =>
  `Current model:
${stableJson(doc)}
Instruction: ${instruction}
Return only the ops array.`;

export const buildRepairPrompt = (
  doc: IrDocument,
  instruction: string,
  rejected: Mutation[],
  errors: AuthoringError[],
): string =>
  `${buildUserPrompt(doc, instruction)}

Your previous ops were rejected:
${stableJson(rejected)}
Fix these errors:
${errors.map((e) => `- [${e.code}] ${e.message}`).join("\n")}
Return corrected ops only.`;
