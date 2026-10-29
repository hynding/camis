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
/** A foreign key column a relation puts on a content type's table. */
export interface ForeignKeyColumn {
  column: string;
  /** The content type whose table the key points at. */
  references: string;
  table: string;
  /** The column without its constraint: `$table->foreignId('author_id')->nullable()`. */
  definition: string;
  /** What deleting the referenced row does, as a constraint modifier (`->nullOnDelete()`), or "". */
  onDelete: string;
}

/** The column with its constraint, as a create-table migration declares it. */
export const constrainedColumn = (key: ForeignKeyColumn): string =>
  `${key.definition}->constrained('${key.table}')${key.onDelete}`;

export interface ResolvedRelations {
  methods: Map<string, RelationMethod[]>;
  formFields: Map<string, string[]>;
  fkColumns: Map<string, ForeignKeyColumn[]>;
  fkNames: Map<string, string[]>; // plain FK column names (for $fillable)
  pivots: PivotTable[];
}

const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
  const a = m.get(k) ?? [];
  a.push(v);
  m.set(k, a);
};

const method = (
  rel: string,
  name: string,
  target: string,
  args: string,
  chain = "",
): RelationMethod => ({
  import: `${REL_NS}\\${rel}`,
  php: `    public function ${name}(): ${rel}\n    {\n        return $this->${rel[0]!.toLowerCase() + rel.slice(1)}(${target}::class, ${args})${chain};\n    }`,
});

// Links the admin's multi-select (or any attach) writes take the end of both sides' lists.
const LINK_PIVOT = "->using(\\App\\Support\\StrapiLinkPivot::class)";

type RelationField = Extract<Field, { type: "relation" }>;

/**
 * Admin pickers offer the rows a link may hold: a draft-and-publish target's drafts, which every
 * link goes through, and a localized target's rows in the record's locale (the default locale,
 * from a type that is not localized).
 */
const pickable = (
  targetVersioned: boolean,
  targetLocalized: boolean,
  sourceLocalized: boolean,
): string => {
  const narrow = [
    ...(targetVersioned ? ["->whereNull('published_at')"] : []),
    ...(targetLocalized
      ? [
          sourceLocalized
            ? "->where('locale', $get('locale'))"
            : "->where('locale', \\App\\Support\\StrapiLocales::default())",
        ]
      : []),
  ];
  if (narrow.length === 0) return "";
  const args = targetLocalized && sourceLocalized ? "$query, $get" : "$query";
  return `, modifyQueryUsing: fn (${args}) => $query${narrow.join("")}`;
};

/**
 * `versioned` names the draft-and-publish content types: their published versions come and go
 * (unpublish deletes one), so a nullable foreign key to such a row unlinks rather than blocks.
 * `linkOrder` says the pivots keep Strapi's link order (the Strapi API style's `*_ord` columns).
 */
export const resolveRelations = (
  doc: IrDocument,
  versioned: ReadonlySet<string> = new Set(),
  localized: ReadonlySet<string> = new Set(),
  linkOrder = false,
): ResolvedRelations => {
  // A to-one or a pivot to a row whose version or locale can go away unlinks rather than blocks.
  const removable = (name: string): boolean => versioned.has(name) || localized.has(name);
  const picker = (target: string, source: string): string =>
    pickable(versioned.has(target), localized.has(target), localized.has(source));
  const out: ResolvedRelations = {
    methods: new Map(),
    formFields: new Map(),
    fkColumns: new Map(),
    fkNames: new Map(),
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
        push(out.fkColumns, owner, {
          column: fk,
          references: target,
          table: targetN.table,
          definition: `$table->foreignId('${fk}')${required ? "" : "->nullable()"}${unique}`,
          onDelete: !required && removable(target) ? "->nullOnDelete()" : "",
        });
        push(out.fkNames, owner, fk);
        push(
          out.formFields,
          owner,
          `Select::make('${fk}')->relationship(name: '${f.name}', titleAttribute: 'id'${picker(target, owner)})`,
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
        push(out.fkColumns, target, {
          column: fk,
          references: owner,
          table: ownerN.table,
          definition: `$table->foreignId('${fk}')->nullable()`,
          onDelete: removable(owner) ? "->nullOnDelete()" : "",
        });
        push(out.fkNames, target, fk);
        if (f.inverse !== undefined) {
          push(out.methods, target, method("BelongsTo", f.inverse, ownerN.model, `'${fk}'`));
          push(
            out.formFields,
            target,
            `Select::make('${fk}')->relationship(name: '${f.inverse}', titleAttribute: 'id'${picker(owner, target)})`,
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
        // A relation to its own type keeps no order (Strapi's link table names both sides alike).
        const chain = linkOrder && a !== b ? LINK_PIVOT : "";
        push(
          out.methods,
          owner,
          method(
            "BelongsToMany",
            f.name,
            targetN.model,
            `'${pivot}', '${ownerFk}', '${targetFk}'`,
            chain,
          ),
        );
        push(
          out.formFields,
          owner,
          `Select::make('${f.name}')->multiple()->relationship(name: '${f.name}', titleAttribute: 'id'${picker(target, owner)})`,
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
              chain,
            ),
          );
          push(
            out.formFields,
            target,
            `Select::make('${f.inverse}')->multiple()->relationship(name: '${f.inverse}', titleAttribute: 'id'${picker(owner, target)})`,
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
