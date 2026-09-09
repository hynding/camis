/**
 * The one place this package turns an author-controlled string into a quoted literal.
 *
 * Content-type, field, component, table, column, role and permission-key names all originate in
 * the IR — which a human or the AI authoring path writes — and end up interpolated into emitted
 * PHP. Every emitter used to carry its own copy of this two-character escape (five of them, all
 * identical), so a new emitter could silently ship without one: a name containing `'` would then
 * close the literal early and turn the rest of the name into PHP source.
 */

/** A single-quoted PHP string literal for `s`, escaping backslashes and single quotes. */
export const phpSingleQuoted = (s: string): string =>
  `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A single-quoted SQL string literal for `s`, doubling embedded quotes (the ANSI escape; a
 * backslash is not an escape character in standard SQL, so it must pass through untouched).
 */
export const sqlSingleQuoted = (s: string): string => `'${s.replace(/'/g, "''")}'`;
