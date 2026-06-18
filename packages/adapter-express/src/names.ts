import type { ContentType } from "@camis/ir-schema";

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

const pluralize = (word: string): string => {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

export const snakeColumn = (fieldName: string): string => snake(fieldName);

export interface ExpressNames {
  table: string;
  routeBase: string;
}

export const expressNames = (ct: ContentType): ExpressNames => {
  const singular = snake(ct.name);
  const plural = ct.names?.plural ? snake(ct.names.plural) : pluralize(singular);
  return { table: plural, routeBase: plural };
};
