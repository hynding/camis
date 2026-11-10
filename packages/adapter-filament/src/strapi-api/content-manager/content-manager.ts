import {
  fieldApiName,
  inverseApiName,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { strapiNames } from "@camis/strapi-schema";
import { phpSingleQuoted } from "../../php-literal";
import type { AdminRelation } from "../../relations";

/**
 * Strapi's Content Manager view of a content type: each attribute in schema order (`id` first,
 * the timestamps and creator fields last), as Strapi types it, with what the admin offers for it.
 * The resource carries it as `CONTENT_MANAGER`, which `StrapiContentManager` lays the list and
 * the edit form out by, after the view configuration a user saved (Strapi's "Configure the view").
 */
export interface ContentManagerAttribute {
  /** The attribute's name, as Strapi's schema and its view configuration name it. */
  name: string;
  /** Strapi's attribute type (`string`, `relation`, `dynamiczone`, …). */
  type: string;
  /** A relation's cardinality, as Strapi words it. */
  relation?: string;
  /** Its form components: none when the edit view does not show it. */
  components: string[];
  /** Its list column, when Strapi's list can show it. */
  column?: string;
  /** Its filter, when Strapi's list filters by it. */
  constraint?: string;
  sortable: boolean;
}

const STRAPI_TYPES: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

export const strapiType = (field: Field): string => STRAPI_TYPES[field.type] ?? field.type;

// The Content Manager's NON_SORTABLES; a to-many relation does not sort either.
const NOT_SORTED = new Set(["component", "json", "media", "richtext", "dynamiczone", "blocks"]);
// Its field sizes: a full row, not resizable; small; and the default, half a row.
const FULL_ROW = new Set(["dynamiczone", "component", "json", "richtext", "blocks"]);
const SMALL = new Set(["boolean", "date", "time", "biginteger", "decimal", "float", "integer"]);

const size = (type: string): { size: number; resizable: boolean } =>
  FULL_ROW.has(type)
    ? { size: 12, resizable: false }
    : { size: SMALL.has(type) ? 4 : 6, resizable: true };

// The filters Strapi's list offers (its NOT_ALLOWED_FILTERS left out), as Filament constraints.
const TEXT_CONSTRAINT = "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\TextConstraint";
const NUMBER_CONSTRAINT = "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\NumberConstraint";
const BOOLEAN_CONSTRAINT =
  "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\BooleanConstraint";
const DATE_CONSTRAINT = "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\DateConstraint";
const SELECT_CONSTRAINT = "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\SelectConstraint";
const RELATIONSHIP_CONSTRAINT =
  "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\RelationshipConstraint";
const IS_RELATED_TO =
  "Filament\\Tables\\Filters\\QueryBuilder\\Constraints\\RelationshipConstraint\\Operators\\IsRelatedToOperator";

const CONSTRAINTS: Record<string, string> = {
  string: "TextConstraint",
  text: "TextConstraint",
  email: "TextConstraint",
  uid: "TextConstraint",
  time: "TextConstraint",
  integer: "NumberConstraint",
  biginteger: "NumberConstraint",
  float: "NumberConstraint",
  decimal: "NumberConstraint",
  boolean: "BooleanConstraint",
  date: "DateConstraint",
  datetime: "DateConstraint",
  timestamp: "DateConstraint",
};

export const CONTENT_MANAGER_IMPORTS = {
  constraints: [
    TEXT_CONSTRAINT,
    NUMBER_CONSTRAINT,
    BOOLEAN_CONSTRAINT,
    DATE_CONSTRAINT,
    SELECT_CONSTRAINT,
    RELATIONSHIP_CONSTRAINT,
    IS_RELATED_TO,
  ],
};

const scalarConstraint = (field: Field, type: string, column: string): string | undefined => {
  const nullable = (field as { required?: boolean }).required === true ? "" : "->nullable()";
  if (field.type === "enumeration") {
    const options = field.values.map((v) => `${phpSingleQuoted(v)} => ${phpSingleQuoted(v)}`);
    return `SelectConstraint::make('${column}')->options([${options.join(", ")}])->multiple()${nullable}`;
  }
  const constraint = CONSTRAINTS[type];
  return constraint === undefined ? undefined : `${constraint}::make('${column}')${nullable}`;
};

const relationConstraint = (
  relation: string,
  title: string,
  multiple: boolean,
  drafts = false,
): string =>
  `RelationshipConstraint::make('${relation}')${multiple ? "->multiple()" : ""}->selectable(IsRelatedToOperator::make()->titleAttribute('${title}')${drafts ? "->modifyRelationshipQueryUsing(fn ($query) => $query->whereNull('published_at'))" : ""}->searchable()->multiple())`;

/** The admin account an admin write records, as Strapi's createdBy and updatedBy. */
const creator = (name: string, relation: string): ContentManagerAttribute => ({
  name,
  type: "relation",
  relation: "oneToOne",
  components: [],
  column: `TextColumn::make('${relation}.firstname')->sortable()`,
  constraint: relationConstraint(relation, "firstname", false),
  sortable: true,
});

const timestamp = (name: string, column: string): ContentManagerAttribute => ({
  name,
  type: "datetime",
  components: [],
  column: `TextColumn::make('${column}')->dateTime()->sortable()`,
  constraint: `DateConstraint::make('${column}')`,
  sortable: true,
});

/** What the admin has for one IR field: its form components and, for a scalar, its list column. */
export interface FieldAdmin {
  field: Field;
  components: string[];
  /** The column it is kept in, when it is one. */
  column?: string;
  /** Its list column, as the plain list has it (searched and sorted). */
  tableColumn?: string;
}

/**
 * The type's attributes as Strapi's Content Manager sees them: `id`, each field in schema order,
 * each relation another type declares the inverse of, the timestamps, and the creator fields.
 */
export const contentManagerAttributes = (
  fields: readonly FieldAdmin[],
  inverses: readonly AdminRelation[],
  relations: readonly AdminRelation[],
): ContentManagerAttribute[] => {
  const relationOf = (name: string): AdminRelation | undefined =>
    relations.find((r) => r.attribute === name);
  const own = fields.map(({ field, components, column, tableColumn }): ContentManagerAttribute => {
    const type = strapiType(field);
    if (field.type === "relation") {
      const admin = relationOf(field.name);
      const multiple = field.relationKind === "manyToMany" || field.relationKind === "oneToMany";
      return {
        name: fieldApiName(field),
        type,
        relation: field.relationKind,
        components,
        ...(admin === undefined ? {} : relationListing(admin)),
        sortable: !multiple && admin !== undefined,
      };
    }
    const sortable = !NOT_SORTED.has(type) && column !== undefined;
    return {
      name: fieldApiName(field),
      type,
      components,
      ...(tableColumn === undefined || column === undefined
        ? {}
        : {
            column: tableColumn,
            ...withConstraint(scalarConstraint(field, type, column)),
          }),
      sortable,
    };
  });
  const inverse = inverses.map(
    (r): ContentManagerAttribute => ({
      name: r.attribute,
      type: "relation",
      relation: r.multiple ? "manyToMany" : "manyToOne",
      components: [r.component],
      ...relationListing(r),
      sortable: !r.multiple,
    }),
  );
  return [
    {
      name: "id",
      type: "integer",
      components: [],
      column: "TextColumn::make('id')->sortable()",
      constraint: "NumberConstraint::make('id')",
      sortable: true,
    },
    ...own,
    ...inverse,
    timestamp("createdAt", "created_at"),
    timestamp("updatedAt", "updated_at"),
    creator("createdBy", "createdBy"),
    creator("updatedBy", "updatedBy"),
  ];
};

const withConstraint = (constraint: string | undefined): { constraint?: string } =>
  constraint === undefined ? {} : { constraint };

const relationListing = (r: AdminRelation): { column: string; constraint: string } => ({
  column: r.multiple
    ? `TextColumn::make('${r.relation}_count')->counts('${r.relation}')`
    : `TextColumn::make('${r.relation}.${r.titleAttribute}')->sortable()`,
  constraint: relationConstraint(r.relation, r.titleAttribute, r.multiple, r.drafts),
});

const phpBool = (b: boolean): string => (b ? "true" : "false");

/** The resource's CONTENT_MANAGER constant: what `StrapiContentManager` lays the views out by. */
export const contentManagerConstant = (
  ct: ContentType,
  attributes: readonly ContentManagerAttribute[],
): string => {
  const rows = attributes.map((a) => {
    const { size: width, resizable } = size(a.type);
    const parts = [
      `'type' => '${a.type}'`,
      ...(a.relation === undefined ? [] : [`'relation' => '${a.relation}'`]),
      `'list' => ${phpBool(a.column !== undefined)}`,
      `'sort' => ${phpBool(a.sortable)}`,
      `'edit' => ${phpBool(a.components.length > 0)}`,
      `'size' => ${width}`,
      `'resizable' => ${phpBool(resizable)}`,
    ];
    return `            '${a.name}' => [${parts.join(", ")}],`;
  });
  return `

    /** Strapi's Content Manager view of this type: its uid and each attribute, in schema order. */
    public const CONTENT_MANAGER = [
        'uid' => '${strapiNames(ct).uid}',
        'attributes' => [
${rows.join("\n")}
        ],
    ];`;
};

/** A PHP array keyed by attribute, of what each attribute has (those that have none left out). */
export const keyedByAttribute = (
  attributes: readonly ContentManagerAttribute[],
  pick: (a: ContentManagerAttribute) => string | undefined,
  indent: string,
): string =>
  attributes
    .flatMap((a) => {
      const value = pick(a);
      return value === undefined ? [] : [`${indent}'${a.name}' => ${value},`];
    })
    .join("\n");

/**
 * The fields that keep Strapi from duplicating an entry directly (strapi-php's
 * getProhibitedCloningFields): uid and unique fields, and one-to-one and one-to-many relations
 * with an inverse, which a copy would take from the entry copied; inside components too. Strapi
 * then opens the create form filled with the entry instead, for those fields to be changed.
 */
export const prohibitedCloningFields = (doc: IrDocument, ct: ContentType): string[] => {
  const components = new Map<string, Component>(doc.components.map((c) => [c.name, c]));
  const walk = (fields: readonly Field[], prefix: string[]): string[] =>
    fields.flatMap((f): string[] => {
      const path = [...prefix, fieldApiName(f)];
      switch (f.type) {
        case "relation":
          return (f.relationKind === "oneToOne" || f.relationKind === "oneToMany") &&
            f.inverse !== undefined
            ? [path.join(".")]
            : [];
        case "component": {
          const component = components.get(f.component);
          return component === undefined ? [] : walk(component.fields, path);
        }
        case "dynamicZone":
          return f.components.flatMap((name) => {
            const component = components.get(name);
            return component === undefined ? [] : walk(component.fields, [...path, name]);
          });
        case "uid":
          return [path.join(".")];
        default:
          return (f as { unique?: boolean }).unique === true ? [path.join(".")] : [];
      }
    });
  // An inverse is one-to-many (of a many-to-one) or one-to-one (of a one-to-one) on this side.
  const inverses = doc.contentTypes.flatMap((other) =>
    other.fields.flatMap((f): string[] =>
      f.type === "relation" &&
      f.target === ct.name &&
      (f.relationKind === "manyToOne" || f.relationKind === "oneToOne")
        ? [inverseApiName(f)].filter((n): n is string => n !== undefined)
        : [],
    ),
  );
  return [...walk(ct.fields, []), ...inverses];
};
