import { runtimePhp } from "../runtime-php";

/**
 * The GraphQL fields Strapi's own plugins add to the content API, over the generated REST
 * controllers as StrapiGraphql's content fields are: users-permissions' sign-in, users and roles,
 * i18n's locales and upload's files. graphql-plugin-vectors.json, recorded from strapi-php, is
 * the check.
 *
 * The REST plugin routes answer bare lists without pages, so a list is paged here; roles and
 * locales are few, and are filtered and sorted here too.
 */
export const emitStrapiGraphqlPlugins = (): string =>
  runtimePhp(new URL("./php/app/GraphQL/StrapiGraphqlPlugins.php", import.meta.url));
