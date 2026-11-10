import { runtimePhp } from "../runtime-php";

/**
 * Strapi's API and transfer tokens, brought over from a Strapi project's database. `strapi export`
 * leaves admin data out of its archive, tokens among it, so `php artisan strapi:import-tokens`
 * reads Strapi's token tables directly. Both kinds of token are kept as an HMAC of the key under
 * Strapi's own salt here too, so with `API_TOKEN_SALT` and `TRANSFER_TOKEN_SALT` set to the
 * project's, every key its clients hold keeps working; given the project's `ENCRYPTION_KEY`, an
 * API token's key is decrypted and kept encrypted under this app's key, so the admin can show it
 * again. The canonical check is `transfer/token-import-vectors.json`, recorded from strapi-php.
 */

export const TOKEN_IMPORT_ENGINE_PATH = "app/Support/StrapiTokenImport.php";
export const TOKEN_IMPORT_COMMAND_PATH = "app/Console/Commands/StrapiImportTokens.php";

export const emitStrapiTokenImport = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiTokenImport.php", import.meta.url));

/** The command: where Strapi's database is, its encryption key, and a summary. */
export const emitStrapiImportTokensCommand = (): string =>
  runtimePhp(new URL("./php/app/Console/Commands/StrapiImportTokens.php", import.meta.url));
