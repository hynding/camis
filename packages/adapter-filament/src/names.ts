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

export const filamentNames = (ct: ContentType): FilamentNames => {
  const model = studly(ct.name);
  const singularSnake = snake(ct.name);
  const pluralSnake = ct.names?.plural ? snake(ct.names.plural) : pluralize(singularSnake);
  const resourceDir = studly(pluralSnake);
  return {
    model,
    table: pluralSnake,
    resourceDir,
    resourceClass: `${model}Resource`,
    formClass: `${model}Form`,
    tableClass: `${resourceDir}Table`,
  };
};
