import { runtimePhp } from "../../runtime-php";

/** `config/cors.php` for Laravel's `HandleCors`, set up as Strapi's `strapi::cors`. */
export const emitCorsConfig = (): string =>
  runtimePhp(new URL("./php/config/cors.php", import.meta.url));
