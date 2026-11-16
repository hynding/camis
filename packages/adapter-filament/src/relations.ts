import {
  fieldApiName,
  type ContentType,
  type Field,
  type IrDocument,
  type RelationKind,
} from "@camis/ir-schema";
import { filamentNames, snake, snakeColumn } from "./names";

/** The field types Strapi's Content Manager lets a relation's entries be titled by. */
const MAIN_FIELD_TYPES = new Set([
  "string",
  "boolean",
  "color",
  "text",
  "uid",
  "email",
  "enumeration",
  "integer",
  "bigInteger",
  "float",
  "decimal",
  "date",
  "dateTime",
  "time",
  "timestamp",
]);

// Strapi's default main field: the first string attribute, else the id.
const defaultMainColumn = (ct: ContentType | undefined): string => {
  const main = ct?.fields.find((f) => f.type === "string");
  return main === undefined ? "id" : snakeColumn(main.name);
};

/**
 * The fields of a relation's target Strapi's view may label a linked entry by (its "entry
 * title"), by the keys they go by on the API, with their columns; the default is the first
 * string field, else the id.
 */
export const relationMainFields = (
  doc: IrDocument,
  target: string,
): Pick<AdminRelation, "mainField" | "mainFields"> => {
  const ct = doc.contentTypes.find((c) => c.name === target);
  const columns: Record<string, string> = { id: "id" };
  for (const f of ct?.fields ?? []) {
    if (MAIN_FIELD_TYPES.has(f.type)) columns[fieldApiName(f)] = snakeColumn(f.name);
  }
  const fallback = defaultMainColumn(ct);
  const main = Object.entries(columns).find(([, column]) => column === fallback);
  return { mainField: main?.[0] ?? "id", mainFields: columns };
};

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

/** A relation attribute as the admin shows it on the type that holds it (its own or an inverse). */
export interface AdminRelation {
  /** The attribute's name on this type, as Strapi's schema names it. */
  attribute: string;
  /** The model's relation method. */
  relation: string;
  /** The form component's state path: the foreign key, or the relation for a to-many. */
  component: string;
  /** The target's main field, which the admin labels a linked entry by. */
  titleAttribute: string;
  /** The same main field by its key on the API, as Strapi's view names it. */
  mainField: string;
  /** Every field of the target a view may label a linked entry by, with its column. */
  mainFields: Record<string, string>;
  multiple: boolean;
  /** The relation's kind as Strapi's schema names it on this side: an inverse sees it reversed. */
  kind: RelationKind;
  /** The target keeps drafts, which links go through, so a filter offers its drafts only. */
  drafts: boolean;
}

export interface ResolvedRelations {
  methods: Map<string, RelationMethod[]>;
  formFields: Map<string, string[]>;
  /** Each type's relation attributes in the admin, in the order of formFields. */
  adminRelations: Map<string, AdminRelation[]>;
  fkColumns: Map<string, ForeignKeyColumn[]>;
  fkNames: Map<string, string[]>; // plain FK column names (for $fillable)
  pivots: PivotTable[];
  /** Some type picks the side of a relation holding no key, which `InverseLinks` writes. */
  inverseLinks: boolean;
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
 * The rows `InverseLinks` reads and writes for a picker on the side of a relation that holds no
 * key: a draft-and-publish target's drafts (its published rows keep their links until the next
 * publish), and a localized target's rows in the record's locale.
 */
const narrowing = (
  targetVersioned: boolean,
  targetLocalized: boolean,
  sourceLocalized: boolean,
): string => {
  const narrow = [
    ...(targetVersioned ? ["->whereNull('published_at')"] : []),
    ...(targetLocalized
      ? [
          sourceLocalized
            ? "->where('locale', $record->getAttribute('locale'))"
            : "->where('locale', \\App\\Support\\StrapiLocales::default())",
        ]
      : []),
  ];
  return narrow.length === 0 ? "" : `, fn ($query) => $query${narrow.join("")}`;
};

/**
 * A picker for the side of a relation that holds no key (a one-to-many's many, a one-to-one's
 * inverse), as Strapi's edit view shows a relation from both sides: `InverseLinks` reads the
 * linked rows (in link order) and writes their keys one by one.
 */
const inversePicker = (
  name: string,
  multiple: boolean,
  titleAttribute: string,
  picker: string,
  narrow: string,
  required: boolean,
): string =>
  `Select::make('${name}')${multiple ? "->multiple()" : ""}->relationship(name: '${name}', titleAttribute: '${titleAttribute}'${picker})` +
  `->loadStateFromRelationshipsUsing(fn (Select $component, $record) => $component->state(\\App\\Support\\InverseLinks::linked($record->${name}()${narrow})))` +
  `->saveRelationshipsUsing(fn (Select $component, $record, $state) => \\App\\Support\\InverseLinks::sync($component, $record->${name}(), $state${narrow}${required ? ", required: true" : ""}))` +
  "->dehydrated(false)";

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
    adminRelations: new Map(),
    fkColumns: new Map(),
    fkNames: new Map(),
    pivots: [],
    inverseLinks: false,
  };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const seenPivot = new Set<string>();
  const names = (n: string): ReturnType<typeof filamentNames> =>
    filamentNames(byName.get(n) as ContentType);
  const label = (n: string): string => defaultMainColumn(byName.get(n));
  const mainFields = (n: string): Pick<AdminRelation, "mainField" | "mainFields"> =>
    relationMainFields(doc, n);
  // The side of a relation holding no key, picked on `holder` among the `rows` type's entries.
  const pickInverse = (
    holder: string,
    rows: string,
    name: string,
    kind: "oneToMany" | "oneToOne",
    required: boolean,
  ): void => {
    out.inverseLinks = true;
    const multiple = kind === "oneToMany";
    push(
      out.formFields,
      holder,
      inversePicker(
        name,
        multiple,
        label(rows),
        picker(rows, holder),
        narrowing(versioned.has(rows), localized.has(rows), localized.has(holder)),
        required,
      ),
    );
    push(out.adminRelations, holder, {
      attribute: name,
      relation: name,
      component: name,
      titleAttribute: label(rows),
      ...mainFields(rows),
      multiple,
      kind,
      drafts: versioned.has(rows),
    });
  };

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
        // A document with a row per version or locale links its target from each of them.
        const unique = kind === "oneToOne" && !removable(owner) ? "->unique()" : "";
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
          `Select::make('${fk}')->relationship(name: '${f.name}', titleAttribute: '${label(target)}'${picker(target, owner)})`,
        );
        push(out.adminRelations, owner, {
          attribute: f.name,
          relation: f.name,
          component: fk,
          titleAttribute: label(target),
          ...mainFields(target),
          multiple: false,
          kind,
          drafts: versioned.has(target),
        });
        if (f.inverse !== undefined) {
          push(
            out.methods,
            target,
            method(kind === "oneToOne" ? "HasOne" : "HasMany", f.inverse, ownerN.model, `'${fk}'`),
          );
          pickInverse(
            target,
            owner,
            f.inverse,
            kind === "manyToOne" ? "oneToMany" : "oneToOne",
            required,
          );
        }
      } else if (kind === "oneToMany") {
        const inverseName = f.inverse ?? snake(owner);
        const fk = `${snakeColumn(inverseName)}_id`;
        push(out.methods, owner, method("HasMany", f.name, targetN.model, `'${fk}'`));
        pickInverse(owner, target, f.name, "oneToMany", false);
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
            `Select::make('${fk}')->relationship(name: '${f.inverse}', titleAttribute: '${label(owner)}'${picker(owner, target)})`,
          );
          push(out.adminRelations, target, {
            attribute: f.inverse,
            relation: f.inverse,
            component: fk,
            titleAttribute: label(owner),
            ...mainFields(owner),
            multiple: false,
            kind: "manyToOne",
            drafts: versioned.has(owner),
          });
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
          `Select::make('${f.name}')->multiple()->relationship(name: '${f.name}', titleAttribute: '${label(target)}'${picker(target, owner)})`,
        );
        push(out.adminRelations, owner, {
          attribute: f.name,
          relation: f.name,
          component: f.name,
          titleAttribute: label(target),
          ...mainFields(target),
          multiple: true,
          kind,
          drafts: versioned.has(target),
        });
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
            `Select::make('${f.inverse}')->multiple()->relationship(name: '${f.inverse}', titleAttribute: '${label(owner)}'${picker(owner, target)})`,
          );
          push(out.adminRelations, target, {
            attribute: f.inverse,
            relation: f.inverse,
            component: f.inverse,
            titleAttribute: label(owner),
            ...mainFields(owner),
            multiple: true,
            kind,
            drafts: versioned.has(owner),
          });
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
