import type { StorageLayout } from "@camis/adapter-kernel";
import {
  fieldApiName,
  type CapabilityGap,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { phpSingleQuoted } from "../php-literal";
import { componentUid } from "./names";
import type { WireScalar, WireShape } from "./wire-shape";

export const VALIDATOR_PATH = "app/Support/StrapiValidator.php";

/** Strapi's names for the IR's types where they differ. */
const STRAPI_TYPE: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

/** Strapi checks a uid's uniqueness whether or not its attribute says unique. */
const isUnique = (field: Field): boolean =>
  field.type === "uid" || ("unique" in field && field.unique === true);

const derived = (field: Field): boolean => "computed" in field && field.computed !== undefined;

/** A to-one link: one target replaces another, so a disconnect alone empties it. */
const toOne = (field: Field): boolean =>
  field.type === "relation"
    ? field.relationKind === "manyToOne" || field.relationKind === "oneToOne"
    : field.type === "media" && field.multiple !== true;

type Rule = Record<string, unknown>;

/** Where a unique field's value is stored: a column of the entry's row, or of its items' rows. */
interface UniqueTarget {
  relation?: string;
  column: string;
}

/** Finds where a field of the current level is stored, by its API key; undefined when unknown. */
type Locate = (key: string) => UniqueTarget | undefined;

interface RuleContext {
  doc: IrDocument;
  /** The written shape on the laravel layout, where relations and files are written as links. */
  shape: WireShape;
  layout: StorageLayout;
  gaps: CapabilityGap[];
  contentType: string;
  /** Set once a field's uniqueness is checked against the stored rows. */
  unique: boolean;
}

const sameKey = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

const columnOf = (scalars: readonly WireScalar[], key: readonly string[]): string | undefined =>
  scalars.find((s) => sameKey(s.key, key))?.column;

const nowhere: Locate = () => undefined;

/** The entry's own fields, and an embedded component's (its columns are the entry's). */
const embeddedAt =
  (ctx: RuleContext, path: string[]): Locate =>
  (key) => {
    const column = columnOf(ctx.shape.scalars, [...path, key]);
    return column === undefined ? undefined : { column };
  };

/** A repeatable component held directly by the entry: its items are rows of their own table. */
const itemsAt =
  (ctx: RuleContext, key: string): Locate =>
  (field) => {
    const child = ctx.shape.children.find((c) => sameKey(c.key, [key]));
    const column = child === undefined ? undefined : columnOf(child.scalars, [field]);
    return child === undefined || column === undefined
      ? undefined
      : { relation: child.relation, column };
  };

const constraints = (field: Field, locate: Locate, ctx: RuleContext, path: string[]): Rule => {
  const f = field as Field & Record<string, unknown>;
  const rule: Rule = { type: STRAPI_TYPE[field.type] ?? field.type };
  for (const key of ["required", "minLength", "maxLength", "min", "max", "default"] as const)
    if (f[key] !== undefined) rule[key] = f[key];
  if (f.pattern !== undefined) rule.regex = f.pattern;
  if (field.type === "enumeration") rule.enum = field.values;
  if (isUnique(field)) {
    const target = locate(fieldApiName(field));
    if (target === undefined) ctx.gaps.push(uncheckedUnique(ctx, [...path, fieldApiName(field)]));
    else {
      rule.unique = target;
      ctx.unique = true;
    }
  }
  return rule;
};

const uncheckedUnique = (ctx: RuleContext, path: string[]): CapabilityGap => ({
  feature: "uniqueInComponent",
  location: { contentType: ctx.contentType, field: path.join(".") },
  severity: "downgrade",
  message: `"${path.join(".")}" is unique, which camis checks only among a type's own fields${
    ctx.layout === "laravel"
      ? ", its embedded components' and the items of a repeatable component it holds"
      : ""
  }; Strapi's check of it is skipped`,
});

/**
 * Strapi's api.documents.strictRelations: a required relation or file must keep one. Only
 * the laravel layout writes links; the strapi layout reports them as gaps of their own.
 */
const linkRule = (field: Field, ctx: RuleContext): Rule | undefined =>
  ctx.layout === "laravel" && field.required === true
    ? { type: field.type, required: true, toOne: toOne(field) }
    : undefined;

/** Each written field's Strapi attribute, in field order (the order Strapi reports errors in). */
const rules = (
  fields: readonly Field[],
  ctx: RuleContext,
  locate: Locate,
  path: string[],
): Record<string, Rule> => {
  const byName = new Map<string, Component>(ctx.doc.components.map((c) => [c.name, c]));
  const out: Record<string, Rule> = {};
  for (const field of fields) {
    if (derived(field)) continue;
    const key = fieldApiName(field);
    if (field.type === "relation" || field.type === "media") {
      const rule = linkRule(field, ctx);
      if (rule !== undefined) out[key] = rule;
    } else if (field.type === "component") {
      const component = byName.get(field.component);
      const inner =
        ctx.layout !== "laravel"
          ? nowhere
          : field.repeatable
            ? path.length === 0
              ? itemsAt(ctx, key)
              : nowhere
            : locate === nowhere
              ? nowhere
              : embeddedAt(ctx, [...path, key]);
      out[key] = {
        type: "component",
        repeatable: field.repeatable,
        fields: rules(component?.fields ?? [], ctx, inner, [...path, key]),
      };
    } else if (field.type === "dynamicZone") {
      out[key] = {
        type: "dynamiczone",
        components: Object.fromEntries(
          field.components.flatMap((name) => {
            const component = byName.get(name);
            return component === undefined
              ? []
              : [[componentUid(component), rules(component.fields, ctx, nowhere, [...path, key])]];
          }),
        ),
      };
    } else {
      out[key] = constraints(field, locate, ctx, path);
    }
  }
  return out;
};

const literal = (value: unknown, indent: string): string => {
  if (typeof value === "string") return phpSingleQuoted(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => literal(v, indent)).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  // A unique field's place is a small map of plain values, kept on its rule's line.
  const flat = entries.every(
    ([k, v]) => typeof v !== "object" || Array.isArray(v) || k === "unique",
  );
  if (entries.length === 0) return "[]";
  if (flat)
    return `[${entries.map(([k, v]) => `${phpSingleQuoted(k)} => ${literal(v, indent)}`).join(", ")}]`;
  const inner = `${indent}    `;
  return `[\n${entries.map(([k, v]) => `${inner}${phpSingleQuoted(k)} => ${literal(v, inner)},\n`).join("")}${indent}]`;
};

export interface EntityRules {
  /** A controller's `RULES`, which StrapiValidator checks a write's data against. */
  constant: string;
  /** Whether a field is unique, so the controller hands the validator the other entries. */
  unique: boolean;
  gaps: CapabilityGap[];
}

/** A content type's `RULES` on a storage layout, and what of Strapi's checks it cannot make. */
export const entityRules = (
  ct: ContentType,
  doc: IrDocument,
  shape: WireShape,
  layout: StorageLayout,
): EntityRules => {
  const ctx: RuleContext = { doc, shape, layout, gaps: [], contentType: ct.name, unique: false };
  const built = rules(ct.fields, ctx, embeddedAt(ctx, []), []);
  return {
    constant: `    /** Each written field's Strapi attribute, for StrapiValidator. */\n    private const RULES = ${literal(built, "    ")};\n`,
    unique: ctx.unique,
    gaps: ctx.gaps,
  };
};
