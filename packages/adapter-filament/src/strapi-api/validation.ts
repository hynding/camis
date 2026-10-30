import { fieldApiName, type Component, type Field, type IrDocument } from "@camis/ir-schema";
import { phpSingleQuoted } from "../php-literal";
import { componentUid } from "./names";

export const VALIDATOR_PATH = "app/Support/StrapiValidator.php";

/** Strapi's names for the IR's types where they differ. */
const STRAPI_TYPE: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

/** Kept by the code that writes them (relations, files), or derived rather than written. */
const unchecked = (field: Field): boolean =>
  field.type === "relation" ||
  field.type === "media" ||
  ("computed" in field && field.computed !== undefined);

type Rule = Record<string, unknown>;

const constraints = (field: Field): Rule => {
  const f = field as Field & Record<string, unknown>;
  const rule: Rule = { type: STRAPI_TYPE[field.type] ?? field.type };
  for (const key of ["required", "minLength", "maxLength", "min", "max", "default"] as const)
    if (f[key] !== undefined) rule[key] = f[key];
  if (f.pattern !== undefined) rule.regex = f.pattern;
  if (field.type === "enumeration") rule.enum = field.values;
  return rule;
};

/** Each written field's Strapi attribute, in field order (the order Strapi reports errors in). */
const rules = (fields: readonly Field[], doc: IrDocument): Record<string, Rule> => {
  const byName = new Map<string, Component>(doc.components.map((c) => [c.name, c]));
  const out: Record<string, Rule> = {};
  for (const field of fields) {
    if (unchecked(field)) continue;
    if (field.type === "component") {
      const component = byName.get(field.component);
      out[fieldApiName(field)] = {
        type: "component",
        repeatable: field.repeatable,
        fields: rules(component?.fields ?? [], doc),
      };
    } else if (field.type === "dynamicZone") {
      out[fieldApiName(field)] = {
        type: "dynamiczone",
        components: Object.fromEntries(
          field.components.flatMap((name) => {
            const component = byName.get(name);
            return component === undefined
              ? []
              : [[componentUid(component), rules(component.fields, doc)]];
          }),
        ),
      };
    } else {
      out[fieldApiName(field)] = constraints(field);
    }
  }
  return out;
};

const literal = (value: unknown, indent: string): string => {
  if (typeof value === "string") return phpSingleQuoted(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => literal(v, indent)).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  const flat = entries.every(([, v]) => typeof v !== "object" || Array.isArray(v));
  if (entries.length === 0) return "[]";
  if (flat)
    return `[${entries.map(([k, v]) => `${phpSingleQuoted(k)} => ${literal(v, indent)}`).join(", ")}]`;
  const inner = `${indent}    `;
  return `[\n${entries.map(([k, v]) => `${inner}${phpSingleQuoted(k)} => ${literal(v, inner)},\n`).join("")}${indent}]`;
};

/** A controller's `RULES`, which StrapiValidator checks a write's data against. */
export const rulesConstant = (fields: readonly Field[], doc: IrDocument): string =>
  `    /** Each written field's Strapi attribute, for StrapiValidator. */\n    private const RULES = ${literal(rules(fields, doc), "    ")};\n`;
