import type { IrDocument, RelationKind } from "@camis/ir-schema";
import { kebab } from "./names";

const DUAL: Record<RelationKind, RelationKind> = {
  oneToOne: "oneToOne",
  oneToMany: "manyToOne",
  manyToOne: "oneToMany",
  manyToMany: "manyToMany",
};

export const dual = (kind: RelationKind): RelationKind => DUAL[kind];

// Map<targetTypeName, { [inverseFieldName]: strapiRelationAttribute }>
export const synthesizedInverses = (doc: IrDocument): Map<string, Record<string, unknown>> => {
  const byTarget = new Map<string, Record<string, unknown>>();
  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type === "relation" && f.inverse !== undefined) {
        const ownerSingular = kebab(ct.name);
        const bucket = byTarget.get(f.target) ?? {};
        bucket[f.inverse] = {
          type: "relation",
          relation: DUAL[f.relationKind],
          target: `api::${ownerSingular}.${ownerSingular}`,
          mappedBy: f.name,
        };
        byTarget.set(f.target, bucket);
      }
    }
  }
  return byTarget;
};
