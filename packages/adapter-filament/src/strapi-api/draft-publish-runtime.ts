import { runtimePhp } from "../runtime-php";

/**
 * Strapi 5's document model for a `draftPublish` type: every document has a draft row, which every
 * write goes through, and once published a second row with `published_at` set. Publishing copies
 * the draft over the published row — columns, repeatable components and the links this type holds
 * — mapping each link to a draft-and-publish target onto that target's published version, so a
 * published document only ever links published ones (strapi-php's document service does the
 * same). The published row is updated in place on republish, which keeps links other rows hold to
 * it. The canonical check is `draft-publish-vectors.json`, recorded from strapi-php.
 */
export const emitStrapiDocuments = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiDocuments.php", import.meta.url));

/** The model half: the published_at cast and the published sibling the admin lists with. */
export const emitHasDraftAndPublish = (): string =>
  runtimePhp(new URL("./php/app/Models/Concerns/HasDraftAndPublish.php", import.meta.url));
