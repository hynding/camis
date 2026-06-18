import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import { fail, parseDocument, type IrDocument, type Result } from "@camis/ir-schema";

export const camisSchemaFile = (doc: IrDocument): GeneratedFile => ({
  path: "camis.schema.json",
  content: stableJson(doc) + "\n",
});

export const importExpressProject = (
  files: { path: string; content: string }[],
): { document: Result<IrDocument> } => {
  const f = files.find((x) => x.path === "camis.schema.json");
  if (!f) {
    return {
      document: fail([
        {
          code: "invalid_document",
          message: "camis.schema.json not found",
          location: {},
          path: [],
        },
      ]),
    };
  }
  return { document: parseDocument(JSON.parse(f.content)) };
};
