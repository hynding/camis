import type { GenerationResult } from "@camis/adapter-kernel";

export interface Io {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  materialize(result: GenerationResult, destDir: string): Promise<void>;
  out(line: string): void;
  cwd: string;
}
