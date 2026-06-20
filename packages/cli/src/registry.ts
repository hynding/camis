import type { GenerateAdapter } from "@camis/adapter-kernel";
import { expressAdapterFor } from "@camis/adapter-express";
import { filamentAdapter } from "@camis/adapter-filament";
import { strapiAdapter } from "@camis/adapter-strapi";
import type { TargetConfig } from "./config";

export const adapterFor = (t: TargetConfig): GenerateAdapter => {
  if (t.target === "express") return expressAdapterFor(t.dialect ?? "sqlite");
  if (t.target === "strapi") return strapiAdapter;
  return filamentAdapter;
};
