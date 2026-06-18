import { sha256, stableJson } from "@camis/adapter-kernel";
import type { Expression } from "@camis/expr";

/** Deterministic, dedup-friendly Strapi condition name derived from the predicate. */
export const conditionName = (predicate: Expression): string =>
  `camis-cond-${sha256(stableJson(predicate)).slice(0, 8)}`;
