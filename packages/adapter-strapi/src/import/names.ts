export const irName = (kebab: string): string =>
  kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** An attribute name as an IR field name: `hero_title` → `heroTitle`. */
export const fieldNameOf = (attribute: string): string =>
  attribute
    .split(/[_-]+/)
    .filter((w) => w !== "")
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join("");
