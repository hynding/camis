import ts from "typescript";
import { describe, expect, it } from "vitest";
import { morphs } from "./__fixtures__/morphs";
import { secured } from "./__fixtures__/secured";
import { expressAdapter } from "./generate";

/** The syntax errors TypeScript finds in one emitted file. */
const syntaxErrors = (path: string, content: string): string[] =>
  (ts.transpileModule(content, { fileName: path, reportDiagnostics: true }).diagnostics ?? []).map(
    (d) => `${path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
  );

// tsx runs the generated API without type-checking it, so a file that does not parse only shows
// when the server boots; this catches it at generation.
describe("the emitted TypeScript", () => {
  for (const [name, bundle] of [
    ["secured", secured],
    ["morphs", morphs],
  ] as const) {
    it(`parses (${name})`, () => {
      const files = expressAdapter
        .generate(bundle, { projectName: name })
        .files.filter((f) => /\.tsx?$/.test(f.path));
      expect(files.flatMap((f) => syntaxErrors(f.path, f.content))).toEqual([]);
    });
  }
});
