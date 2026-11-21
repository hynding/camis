import ts from "typescript";
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

// The generated project's tsconfig sets noEmitOnError, so a type error in an emitted file stops
// Strapi from building at all. @strapi/strapi is not installed here; its factory is declared.
const STRAPI_STUB = `declare module "@strapi/strapi" {
  export const factories: { createCoreController(uid: string, cfg?: (p: { strapi: unknown }) => unknown): unknown };
}
`;

describe("the emitted enforcement compiles under the generated project's tsconfig", () => {
  it("has no type errors", () => {
    const result = strapiAdapter.generate(ownershipBundle, { projectName: "notes" });
    const sources = new Map<string, string>([["/project/strapi.d.ts", STRAPI_STUB]]);
    for (const path of [
      "src/permissions/api-conditions.ts",
      "src/permissions/api-controller.ts",
      "src/api/note/controllers/note.ts",
    ]) {
      sources.set(`/project/${path}`, result.files.find((f) => f.path === path)!.content);
    }
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2019,
      lib: ["lib.es2020.d.ts"],
      strict: false,
      noImplicitThis: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = (name) => sources.get(name) ?? read(name);
    host.fileExists = (name) => sources.has(name) || ts.sys.fileExists(name);
    const program = ts.createProgram([...sources.keys()], options, host);
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map(
        (d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      );
    expect(messages).toEqual([]);
  });
});
