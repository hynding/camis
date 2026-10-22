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
  /**
   * Filament, Strapi API style only: send components without `populate` asking for them, as
   * camis did before it matched Strapi 5. Default false. A deployment can still flip it with
   * CAMIS_REST_ALWAYS_POPULATE_COMPONENTS.
   */
  alwaysPopulateComponents?: boolean;
  /** Filament, Strapi API style only: serve Strapi 5's GraphQL content API at /graphql. Default false. */
  graphql?: boolean;
  /**
   * Filament, Strapi API style only: write Strapi 5's OpenAPI 3.1 document and serve Swagger UI
   * at /documentation. Default false.
   */
  documentation?: boolean;
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
