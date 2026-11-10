import { runtimePhp } from "../../runtime-php";

/**
 * Strapi 5's `populate` over Eloquent: components and relations stay off the wire unless the
 * request names them (`populate=*`, `populate=a,b`, `populate[0]=a.b`, `populate[a][fields]`,
 * `[filters]`, `[sort]`, `[populate]`, `[count]`), as strapi-php's `convert-query-params` and
 * populate validation do. Each relation is eager-loaded once per level for the whole page, so a
 * list costs one query per populated relation rather than one per row — what keeps it cheap on
 * shared hosting. The canonical check is `populate-vectors.json`, recorded from strapi-php.
 *
 * Draft and publish: every level shows the version the request's status names. Links between two
 * versioned types, and from a versioned type to a plain one, are held per version, so they load
 * as they are. A link a plain type holds to a versioned one points at the target's draft and is
 * shown as its published version; a link a plain type holds to a versioned one's draft is reached
 * from the published version through that draft (`draft-publish-vectors.json`). The request's
 * publicationFilter narrows every draft-and-publish level, as Strapi's does
 * (`publication-filter-vectors.json`).
 *
 * Locales: a link from a type that keeps locales holds its target in its own locale, and one from
 * a type that does not holds the target's default locale, so both load as they are.
 * `localizations` is the row's document in its other locales (`i18n-vectors.json`).
 */
export const emitStrapiPopulate = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiPopulate.php", import.meta.url));

/**
 * Strapi 5's relation input on create and update: a documentId, a numeric id or an object holding
 * one; a list (which replaces the set); or `{ connect, disconnect, set }`. Every reference is
 * resolved within the caller's view of the target before anything is written, so a bad one fails
 * the whole request with Strapi's 400 and changes nothing.
 *
 * A to-many keeps the order its links were made in, and a connect's position (before, after,
 * start, end) places it, as `StrapiLinkOrder` writes it.
 *
 * A draft-and-publish target is linked through its draft, whichever version the reference names:
 * publishing maps the links onto published versions (`StrapiDocuments`). A documentId names a
 * target that keeps locales in the writer's locale, or its default one when the writer keeps none.
 */
export const emitStrapiRelations = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiRelations.php", import.meta.url));
