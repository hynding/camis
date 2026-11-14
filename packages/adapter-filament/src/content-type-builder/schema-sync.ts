import { runtimePhp } from "../runtime-php";

export const SCHEMA_SYNC_COMMAND_PATH = "app/Console/Commands/CamisSchemaSync.php";
export const SCHEMA_SYNC_PATH = "app/Support/CamisSchemaSync.php";
export const COLUMN_CONVERSION_PATH = "app/Support/ColumnConversion.php";

const source = (path: string): URL =>
  new URL(`../strapi-api/content-type-builder/php/${path}`, import.meta.url);

/** The schema sync: the database brought up to the generated migrations, keeping its data. */
export const emitSchemaSync = (): string => runtimePhp(source(SCHEMA_SYNC_PATH));

/** "php artisan camis:schema-sync": the sync, then "migrate" for the rest and the role seeder. */
export const emitSchemaSyncCommand = (): string => runtimePhp(source(SCHEMA_SYNC_COMMAND_PATH));

/** A column's values carried over to another group of types, as the sync converts a changed field. */
export const emitColumnConversion = (): string => runtimePhp(source(COLUMN_CONVERSION_PATH));
