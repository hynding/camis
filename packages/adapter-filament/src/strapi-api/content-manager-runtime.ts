import { runtimePhp } from "../runtime-php";

export const STRAPI_CONTENT_MANAGER_PATH = "app/Support/StrapiContentManager.php";
export const CONFIGURE_VIEW_PATH = "app/Filament/Support/ConfigureView.php";

/**
 * Strapi's Content Manager view configuration ("Configure the view"): a type's settings, each
 * attribute's metadatas and its list and edit layouts, kept as Strapi's core store keeps them
 * (`plugin_content_manager_configuration_content_types::<uid>`) so an imported configuration
 * applies unchanged. Defaults and the sync after a schema change follow strapi-php's
 * `services/utils/configuration`. A resource's list and form are laid out through it.
 */
export const emitStrapiContentManager = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiContentManager.php", import.meta.url));

/**
 * Strapi's "Configure the view" page, one per content type: the list's settings and columns, and
 * the edit view's fields, each with its label, description, placeholder, size and whether it may
 * be edited. Saved as Strapi's view configuration; the list and form follow it on the next load.
 */
export const emitConfigureView = (): string =>
  runtimePhp(new URL("./php/app/Filament/Support/ConfigureView.php", import.meta.url));

export const STRAPI_UID_PATH = "app/Support/StrapiUid.php";
export const HAS_CREATOR_FIELDS_PATH = "app/Models/Concerns/HasCreatorFields.php";

/**
 * Strapi's uid field in the Content Manager (strapi-php's content-manager `services/uid`): a value
 * made from the target field (or the type's name) by Strapi's slugify, suffixed `-1`, `-2`, … until
 * no draft in the locale has it, and whether a value is free for this document.
 */
export const emitStrapiUid = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiUid.php", import.meta.url));

/**
 * Strapi's createdBy and updatedBy: the admin user who made an entry and who last changed it,
 * recorded on writes made in the admin only (an API write records nobody, as in Strapi).
 */
export const emitHasCreatorFields = (): string =>
  runtimePhp(new URL("./php/app/Models/Concerns/HasCreatorFields.php", import.meta.url));
