import type { GenerationResult } from "@camis/adapter-kernel";

export interface Io {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  materialize(result: GenerationResult, destDir: string): Promise<void>;
  /** Recursively copy a directory tree, overwriting files that already exist. */
  copyDir(src: string, dest: string): Promise<void>;
  /** Run a child process (stdio inherited); resolves with its exit code. */
  exec(cmd: string, args: string[], cwd: string): Promise<number>;
  out(line: string): void;
  cwd: string;
}
