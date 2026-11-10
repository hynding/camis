import { runtimePhp } from "../runtime-php";

/** A backtick, which yup's messages quote values in. */
/**
 * Strapi 5's entity validator over a write's data (validation-vectors.json and
 * constraint-vectors.json, recorded from strapi-php): yup's casts, its messages and Strapi's
 * per-type rules. Every failing field is reported, in attribute order, as Strapi's
 * ValidationError: one error's message, or "N errors occurred", with each error's path, message
 * and value under details.errors. A draft skips required, minLength, regex, min and unique, as
 * Strapi's does.
 *
 * $rules is a controller's `RULES`: wire key → Strapi attribute (type, required, minLength,
 * maxLength, min, max, regex, enum, default), a component's `fields`, a dynamic zone's
 * `components`. A unique attribute names where its value is stored (`unique`: a column, and the
 * relation holding its items' rows), and $unique gives the other entries' rows to look in. A
 * required relation or file (`toOne` when one target replaces another) must keep one while
 * camis.documents.strict_relations is on, as Strapi's api.documents.strictRelations.
 */
export const emitStrapiValidator = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiValidator.php", import.meta.url));
