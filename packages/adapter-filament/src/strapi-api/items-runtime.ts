import type { WireChild, WireShape } from "./wire-shape";
import { runtimePhp } from "../runtime-php";

export const ITEMS_PATH = "app/Support/StrapiItems.php";

/** Whether a repeatable's items link anything (files, relations) or hold items of their own. */
export const itemsLinkAnything = (c: WireChild): boolean =>
  c.media.length > 0 || c.relations.length > 0 || c.children.length > 0;

/** Whether a type writes items one by one: a repeatable's that link anything, or a zone's. */
export const writesItems = (shape: WireShape): boolean =>
  shape.children.some(itemsLinkAnything) || shape.zones.length > 0;

/**
 * A repeatable component's items written one by one, as Strapi writes a component: each item's
 * columns, then its links (its to-one keys before it is saved, its files and to-many links once it
 * has an id), then the items of the repeatables inside it, all the way down. A write replaces a
 * repeatable's items whole, as Strapi replaces a component sent without its id.
 */
export const emitStrapiItems = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiItems.php", import.meta.url));
