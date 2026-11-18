import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

const generate = (bundle: IrBundle) =>
  filamentAdapter.generate(bundle, { projectName: "oyl", apiStyle: "strapi", graphql: true });
const fileOf =
  (result: ReturnType<typeof generate>) =>
  (path: string): string =>
    result.files.find((f) => f.path === path || f.path.endsWith(path))?.content ?? "";

// Strapi's plugin services a role may be given (Users & Permissions › Roles): the locales list,
// sending email, reading the roles. The IR names them neutrally; the app seeds each as a permission.
describe("a role's plugin services", () => {
  const file = fileOf(generate(strapiApiBundle));

  it("are seeded as permissions and given to the roles holding them", () => {
    const seeder = file("database/seeders/RolePermissionSeeder.php");
    expect(seeder).toContain("Permission::firstOrCreate(['name' => 'service.locales.list']);");
    expect(seeder).toContain("Permission::firstOrCreate(['name' => 'service.email.send']);");
    expect(seeder).toContain("Permission::firstOrCreate(['name' => 'service.roles.read']);");
    expect(seeder).toMatch(
      /firstOrCreate\(\['name' => 'public'\]\)->givePermissionTo\(\[[^\]]*'service\.locales\.list'/,
    );
  });

  it("are checked where Strapi checks them, for a caller without a token", () => {
    expect(file("app/Http/Controllers/Api/LocaleController.php")).toContain(
      "StrapiServices::authorize($request, 'locales.list');",
    );
    expect(file("app/Http/Controllers/Api/EmailController.php")).toContain(
      "StrapiServices::authorize($request, 'email.send');",
    );
    expect(file("app/Http/Controllers/Api/RoleController.php")).toContain(
      "StrapiServices::authorize(request(), 'roles.read');",
    );
    const services = file("app/Support/StrapiServices.php");
    expect(services).toContain("PublicRole::allows($user, 'service.'.$service)");
    expect(services).toContain("StrapiApiTokens::active()");
  });

  it("read the caller's session on the locales list and the email route", () => {
    const routes = file("routes/api.php");
    const start = routes.indexOf(
      "Route::middleware([StrapiCredentials::class.':optional', StrapiActiveUser::class])->group(function (): void {\n        Route::get('i18n/locales'",
    );
    expect(start).toBeGreaterThan(-1);
    const group = routes.slice(start, routes.indexOf("});", start));
    expect(group).toContain("Route::post('/email', [EmailController::class, 'send']);");
  });

  it("are the users-permissions actions Strapi's roles hold, on the Roles page and in exports", () => {
    const transfer = file("app/Support/StrapiTransferMap.php");
    expect(transfer).toContain("'service.locales.list' => ['plugin::i18n.locales.listLocales']");
    expect(transfer).toContain("'service.email.send' => ['plugin::email.email.send']");
  });

  it("leave an app without roles open, as everything in it is", () => {
    const open = fileOf(generate({ ...strapiApiBundle, roles: [] }));
    expect(open("app/Support/StrapiServices.php")).toContain("return true;");
  });
});
