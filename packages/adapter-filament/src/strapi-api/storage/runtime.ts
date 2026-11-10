import { runtimePhp } from "../../runtime-php";

export { emitStrapiComponents } from "./runtime-components";

/**
 * `App\Casts\StrapiDateTime` — the cast every Strapi datetime column carries.
 *
 * Strapi's physical representation is per driver: SQLite holds integer milliseconds since the
 * epoch, MySQL a `datetime(6)` and Postgres a `timestamp(6)`. Laravel's own `datetime` cast
 * assumes the string form everywhere, so on SQLite it would read `1757280000000` as a year.
 */
export const emitStrapiDateTime = (): string =>
  runtimePhp(new URL("./php/app/Casts/StrapiDateTime.php", import.meta.url));

/**
 * `App\Support\StrapiRows` — the row bookkeeping Strapi does that a Laravel app writing the same
 * tables has to do by hand: the Strapi-owned columns on create, and the `_lnk` rows for relations.
 */
export const emitStrapiRows = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiRows.php", import.meta.url));

/**
 * `App\Support\StrapiComponentAttributes` — the model trait that makes component storage look
 * like ordinary attributes and relations to everything downstream.
 */
export const emitStrapiComponentAttributes = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiComponentAttributes.php", import.meta.url));

/**
 * `App\Http\Middleware\StrapiJwtGuard` — authenticates with the JWT Strapi's users-permissions
 * plugin issues, so a token minted by either app is accepted by both.
 */
export const emitStrapiJwtGuard = (): string =>
  runtimePhp(new URL("./php/app/Http/Middleware/StrapiJwtGuard.php", import.meta.url));
