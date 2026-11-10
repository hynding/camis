import { runtimePhp } from "../../runtime-php";

/**
 * `App\Support\StrapiComponents` — the reader/writer for Strapi's component storage.
 *
 * Split out of `runtime.ts` purely for file size: it is one class, and it is the only one of the
 * five runtime files with real algorithmic weight.
 */
export const emitStrapiComponents = (): string =>
  runtimePhp(new URL("./../php/app/Support/StrapiComponents.php", import.meta.url));
