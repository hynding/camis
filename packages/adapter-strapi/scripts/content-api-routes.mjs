// Copied into the booted project by enforcement-smoke.ts and run there with Strapi stopped:
// loads the app and prints every content API route it registers, with the users-permissions
// permissions each role holds, so the smoke can check them against content-api-allowlist.json.
import { createRequire } from "node:module";
import { join } from "node:path";

const { compileStrapi, createStrapi } = createRequire(join(process.cwd(), "package.json"))(
  "@strapi/strapi",
);

const main = async () => {
  const app = await createStrapi(await compileStrapi()).load();
  const routes = [];
  const take = (namespace, routers) => {
    const list = Array.isArray(routers)
      ? [{ type: "content-api", routes: routers }]
      : Object.values(routers ?? {});
    for (const router of list) {
      if (router.type !== "content-api") continue;
      for (const route of router.routes ?? []) {
        const handler = typeof route.handler === "string" ? route.handler : "<function>";
        routes.push({
          method: route.method,
          path: route.path,
          action: handler.includes("::") ? handler : `${namespace}.${handler}`,
          open: route.config?.auth === false,
        });
      }
    }
  };
  for (const [name, api] of Object.entries(app.apis)) take(`api::${name}`, api.routes);
  for (const [name, plugin] of Object.entries(app.plugins)) take(`plugin::${name}`, plugin.routes);
  const permissions = await app.db
    .query("plugin::users-permissions.permission")
    .findMany({ populate: ["role"] });
  const granted = permissions.map((p) => ({ role: p.role?.type ?? null, action: p.action }));
  process.stdout.write(`CAMIS_ROUTES ${JSON.stringify({ routes, granted })}\n`);
  await app.destroy();
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
