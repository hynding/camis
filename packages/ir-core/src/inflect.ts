const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");

export const humanize = (name: string): string => words(name).join(" ");

export const snakeCase = (name: string): string =>
  words(name)
    .map((w) => w.toLowerCase())
    .join("_");

export const pluralize = (word: string): string => {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
};
