import type { ContentType, Field, IrDocument, RelationKind } from "@camis/ir-schema";
import { filamentNames, snake, snakeColumn } from "./names";

const REL_NS = "Illuminate\\Database\\Eloquent\\Relations";

export interface RelationMethod {
  import: string;
  php: string;
}
export interface PivotTable {
  table: string;
  leftTable: string;
  rightTable: string;
  leftFk: string;
  rightFk: string;
}
export interface ResolvedRelations {
  methods: Map<string, RelationMethod[]>;
  formFields: Map<string, string[]>;
  fkColumns: Map<string, string[]>;
  pivots: PivotTable[];
}

const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
  const a = m.get(k) ?? [];
  a.push(v);
  m.set(k, a);
};

const method = (rel: string, name: string, target: string, args: string): RelationMethod => ({
  import: `${REL_NS}\\${rel}`,
  php: `    public function ${name}(): ${rel}\n    {\n        return $this->${rel[0]!.toLowerCase() + rel.slice(1)}(${target}::class, ${args});\n    }`,
});

type RelationField = Extract<Field, { type: "relation" }>;

export const resolveRelations = (doc: IrDocument): ResolvedRelations => {
  const out: ResolvedRelations = {
    methods: new Map(),
    formFields: new Map(),
    fkColumns: new Map(),
    pivots: [],
  };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const seenPivot = new Set<string>();
  const names = (n: string): ReturnType<typeof filamentNames> =>
    filamentNames(byName.get(n) as ContentType);

  for (const ct of doc.contentTypes) {
    for (const rawField of ct.fields) {
      if (rawField.type !== "relation") continue;
      const f = rawField as RelationField;
      const kind: RelationKind = f.relationKind;
      const owner = ct.name;
      const target = f.target;
      const ownerN = names(owner);
      const targetN = names(target);
      const required = f.required === true;

      if (kind === "manyToOne" || kind === "oneToOne") {
        const fk = `${snakeColumn(f.name)}_id`;
        push(out.methods, owner, method("BelongsTo", f.name, targetN.model, `'${fk}'`));
        const unique = kind === "oneToOne" ? "->unique()" : "";
        push(
          out.fkColumns,
          owner,
          `$table->foreignId('${fk}')${unique}->constrained('${targetN.table}')${required ? "" : "->nullable()"}`,
        );
        push(
          out.formFields,
          owner,
          `Select::make('${fk}')->relationship(name: '${f.name}', titleAttribute: 'id')`,
        );
        if (f.inverse !== undefined) {
          push(
            out.methods,
            target,
            method(kind === "oneToOne" ? "HasOne" : "HasMany", f.inverse, ownerN.model, `'${fk}'`),
          );
        }
      } else if (kind === "oneToMany") {
        const inverseName = f.inverse ?? snake(owner);
        const fk = `${snakeColumn(inverseName)}_id`;
        push(out.methods, owner, method("HasMany", f.name, targetN.model, `'${fk}'`));
        push(
          out.fkColumns,
          target,
          `$table->foreignId('${fk}')->nullable()->constrained('${ownerN.table}')`,
        );
        if (f.inverse !== undefined) {
          push(out.methods, target, method("BelongsTo", f.inverse, ownerN.model, `'${fk}'`));
          push(
            out.formFields,
            target,
            `Select::make('${fk}')->relationship(name: '${f.inverse}', titleAttribute: 'id')`,
          );
        }
      } else {
        // manyToMany
        const a = snake(owner);
        const b = snake(target);
        const [left, right] = a < b ? [a, b] : [b, a];
        const pivot = `${left}_${right}`;
        const ownerFk = `${a}_id`;
        const targetFk = `${b}_id`;
        push(
          out.methods,
          owner,
          method("BelongsToMany", f.name, targetN.model, `'${pivot}', '${ownerFk}', '${targetFk}'`),
        );
        push(
          out.formFields,
          owner,
          `Select::make('${f.name}')->multiple()->relationship(name: '${f.name}', titleAttribute: 'id')`,
        );
        if (f.inverse !== undefined) {
          push(
            out.methods,
            target,
            method(
              "BelongsToMany",
              f.inverse,
              ownerN.model,
              `'${pivot}', '${targetFk}', '${ownerFk}'`,
            ),
          );
          push(
            out.formFields,
            target,
            `Select::make('${f.inverse}')->multiple()->relationship(name: '${f.inverse}', titleAttribute: 'id')`,
          );
        }
        if (!seenPivot.has(pivot)) {
          seenPivot.add(pivot);
          const leftIsOwner = a < b;
          out.pivots.push({
            table: pivot,
            leftTable: names(leftIsOwner ? owner : target).table,
            rightTable: names(leftIsOwner ? target : owner).table,
            leftFk: `${left}_id`,
            rightFk: `${right}_id`,
          });
        }
      }
    }
  }
  return out;
};
