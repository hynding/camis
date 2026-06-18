import type { ContentType, IrDocument, RelationKind } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { expressNames, snakeColumn } from "./names";

export interface ResolvedRelations {
  fkColumns: Map<string, string[]>; // content type name (or "__pivot__<name>") → drizzle FK column lines
  relationBlocks: Map<string, string[]>; // content type name → relations() body lines
}

const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
  const a = m.get(k) ?? [];
  a.push(v);
  m.set(k, a);
};

const fkType = (dialect: Dialect, col: string): string =>
  dialect === "mysql" ? `int('${col}')` : `integer('${col}')`;

export const resolveRelations = (doc: IrDocument, dialect: Dialect): ResolvedRelations => {
  const out: ResolvedRelations = { fkColumns: new Map(), relationBlocks: new Map() };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const seenPivot = new Set<string>();

  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "relation") continue;
      const owner = ct.name;
      const target = f.target;
      const kind: RelationKind = f.relationKind;
      const ownerT = expressNames(byName.get(owner) as ContentType).table;
      const targetT = expressNames(byName.get(target) as ContentType).table;
      const inverse = f.inverse;

      if (kind === "manyToOne" || kind === "oneToOne") {
        const fk = `${snakeColumn(f.name)}_id`;
        const uniq = kind === "oneToOne" ? ".unique()" : "";
        push(
          out.fkColumns,
          owner,
          `  ${fk}: ${fkType(dialect, fk)}${uniq}.references(() => ${targetT}.id),`,
        );
        push(
          out.relationBlocks,
          owner,
          `  ${f.name}: one(${targetT}, { fields: [${ownerT}.${fk}], references: [${targetT}.id] }),`,
        );
        if (inverse) {
          push(
            out.relationBlocks,
            target,
            `  ${inverse}: ${kind === "oneToOne" ? "one" : "many"}(${ownerT}),`,
          );
        }
      } else if (kind === "oneToMany") {
        const fk = `${snakeColumn(inverse ?? owner.toLowerCase())}_id`;
        push(out.relationBlocks, owner, `  ${f.name}: many(${targetT}),`);
        push(
          out.fkColumns,
          target,
          `  ${fk}: ${fkType(dialect, fk)}.references(() => ${ownerT}.id),`,
        );
        if (inverse) {
          push(
            out.relationBlocks,
            target,
            `  ${inverse}: one(${ownerT}, { fields: [${targetT}.${fk}], references: [${ownerT}.id] }),`,
          );
        }
      } else {
        const a = snakeColumn(owner);
        const b = snakeColumn(target);
        const [l, rr] = a < b ? [a, b] : [b, a];
        const pivot = `${l}_${rr}`;
        push(out.relationBlocks, owner, `  ${f.name}: many(${pivot}),`);
        if (inverse) push(out.relationBlocks, target, `  ${inverse}: many(${pivot}),`);
        if (!seenPivot.has(pivot)) {
          seenPivot.add(pivot);
          push(
            out.fkColumns,
            `__pivot__${pivot}`,
            `  ${a}_id: ${fkType(dialect, `${a}_id`)}.references(() => ${ownerT}.id),`,
          );
          push(
            out.fkColumns,
            `__pivot__${pivot}`,
            `  ${b}_id: ${fkType(dialect, `${b}_id`)}.references(() => ${targetT}.id),`,
          );
        }
      }
    }
  }
  return out;
};
