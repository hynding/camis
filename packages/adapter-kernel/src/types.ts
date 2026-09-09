import type { CapabilityGapReport } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";

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

export type ApiStyle = "laravel" | "strapi";

/** Filament only: which app owns the schema/database. Default "laravel". */
export type StorageLayout = "laravel" | "strapi";

export interface GenerateOptions {
  projectName: string;
  /** Filament only: shape of the generated JSON API. Default "laravel". */
  apiStyle?: ApiStyle;
  /** Filament only: run atop a Strapi-owned database instead of a Laravel-owned one. */
  storageLayout?: StorageLayout;
}

export interface GenerationResult {
  files: GeneratedFile[];
  manifest: Manifest;
  gaps: CapabilityGapReport;
}

export interface GenerateAdapter {
  target: string;
  generate(ir: IrBundle, options: GenerateOptions): GenerationResult;
}
