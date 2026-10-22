// Checks the served OpenAPI document against the app: /documentation answers with Swagger UI, and
// every operation the document lists is a route the app registers under /api. Runs only in the
// gated adapter-filament-boot job. usage: node strapi-openapi-routes.mjs <laravel-app-dir> <base-url>
import { execFileSync } from "node:child_process";

const [app, base] = process.argv.slice(2);
if (!app || !base) {
  console.error("usage: node strapi-openapi-routes.mjs <laravel-app-dir> <base-url>");
  process.exit(1);
}

const page = await fetch(`${base}/documentation/`);
const html = await page.text();
if (page.status !== 200 || !html.includes("SwaggerUIBundle")) {
  console.error(`✗ /documentation/ answered ${page.status} without Swagger UI`);
  process.exit(1);
}
const response = await fetch(`${base}/documentation/openapi.json`);
if (response.status !== 200) {
  console.error(`✗ /documentation/openapi.json answered ${response.status}`);
  process.exit(1);
}
const document = await response.json();
const server = document.servers?.[0]?.url;

// `{key}`, `{id}`, `(.*)`: any parameter is the same parameter.
const shape = (uri) => uri.replace(/^\/+/, "").replace(/\{[^}]+\}|\(\.\*\)/g, "{}");
const routes = JSON.parse(
  execFileSync("php", ["artisan", "route:list", "--json"], { cwd: app, encoding: "utf8" }),
).map((r) => ({ uri: shape(r.uri), methods: r.method.split("|") }));

const missing = [];
let operations = 0;
for (const [path, item] of Object.entries(document.paths)) {
  for (const method of Object.keys(item)) {
    operations += 1;
    const uri = shape(`${server}${path}`);
    const verb = method.toUpperCase();
    if (!routes.some((r) => r.uri === uri && r.methods.includes(verb)))
      missing.push(`${verb} ${server}${path}`);
  }
}
if (missing.length > 0) {
  console.error(`✗ documented but not routed:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `✓ /documentation serves Swagger UI; all ${operations} documented operations are routed`,
);
