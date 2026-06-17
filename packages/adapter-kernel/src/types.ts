import type { CapabilityGapReport, IrDocument } from "@camis/ir-schema";

export type FileMode = "overwrite" | "seed";

export interface GeneratedFile {
  path: string; // relative to project root, POSIX separators
  content: string;
  mode?: FileMode; // default "overwrite"
}

export interface ManifestEntry {
  path: string;
  mode: FileMode;
  sha256: string;
}

export interface Manifest {
  generator: string;
  files: ManifestEntry[];
}

export interface GenerateOptions {
  projectName: string;
}

export interface GenerationResult {
  files: GeneratedFile[];
  manifest: Manifest;
  gaps: CapabilityGapReport;
}

export interface GenerateAdapter {
  target: string;
  generate(doc: IrDocument, options: GenerateOptions): GenerationResult;
}
