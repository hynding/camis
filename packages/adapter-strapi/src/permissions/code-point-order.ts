/**
 * Orders strings by UTF-16 code unit, as `<` does: unlike localeCompare, the same on every
 * machine whatever its locale, so generated files stay byte-stable.
 */
export const codePointOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
