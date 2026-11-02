import { fieldApiName, inverseApiName, type IrDocument, type RelationKind } from "@camis/ir-schema";
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
      const inverse = f.type === "relation" ? inverseApiName(f) : undefined;
      if (f.type === "relation" && inverse !== undefined) {
        const ownerSingular = kebab(ct.name);
        const bucket = byTarget.get(f.target) ?? {};
        bucket[inverse] = {
          type: "relation",
          relation: DUAL[f.relationKind],
          target: `api::${ownerSingular}.${ownerSingular}`,
          mappedBy: fieldApiName(f),
        };
        byTarget.set(f.target, bucket);
      }
    }
  }
  return byTarget;
};
