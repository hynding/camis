import type { ContentType } from "@camis/ir-schema";

export interface FilamentNames {
  model: string;
  table: string;
  resourceDir: string;
  resourceClass: string;
  formClass: string;
  tableClass: string;
}

const studly = (name: string): string =>
  name.replace(/(^|[_\- ])([a-z])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[_\- ]/g, "");

export const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

// Minimal pluralizer; the IR `names.plural` override covers irregulars.
const pluralize = (word: string): string => {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

export const snakeColumn = (fieldName: string): string => snake(fieldName);

// Words PHP will not take as a class name (its keywords and reserved type names), lower-cased.
const RESERVED = new Set(
  (
    "abstract and array as bool break callable case catch class clone const continue declare " +
    "default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum " +
    "eval exit extends false final finally float fn for foreach function global goto if implements " +
    "include include_once instanceof insteadof int interface isset iterable list match mixed " +
    "namespace never new null object or parent print private protected public readonly require " +
    "require_once return self static string switch throw trait true try unset use var void while " +
    "xor yield"
  ).split(" "),
);

export const filamentNames = (ct: ContentType): FilamentNames => {
  const base = studly(ct.name);
  // Strapi's starter calls its site-wide single type "global": the model class takes a suffix,
  // and every other name keeps the type's.
  const model = RESERVED.has(base.toLowerCase()) ? `${base}Model` : base;
  const singularSnake = snake(ct.name);
  const pluralSnake = ct.names?.plural ? snake(ct.names.plural) : pluralize(singularSnake);
  const resourceDir = studly(pluralSnake);
  return {
    model,
    table: pluralSnake,
    resourceDir,
    resourceClass: `${base}Resource`,
    formClass: `${base}Form`,
    tableClass: `${resourceDir}Table`,
  };
};
