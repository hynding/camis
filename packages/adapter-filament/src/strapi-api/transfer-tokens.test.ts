import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's transfer tokens (the admin's Transfer Tokens settings and its `data-transfer` strategy
// on /admin/transfer/runner/*); transfer-token-vectors.json, recorded from strapi-php, is the
// behaviour.
describe("transfer tokens", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("keeps each token's salted hash only, as Strapi shows a transfer token once", () => {
    const migration = content(
      "database/migrations/0001_01_02_000006_create_strapi_transfer_tokens_table.php",
    );
    expect(migration).toContain("Schema::create('strapi_transfer_tokens'");
    expect(migration).toContain("$table->string('access_key', 128)->unique();");
    expect(migration).not.toContain("encrypted_key");
    const tokens = content("app/Support/StrapiTransferTokens.php");
    expect(tokens).toContain(
      "hash_hmac('sha512', $key, (string) (config('camis.transfer_tokens.salt') ?: config('app.key')))",
    );
    expect(content("config/camis.php")).toContain("'salt' => env('TRANSFER_TOKEN_SALT'),");
  });

  it("gives a token push, pull or both, for 7, 30 or 90 days or unlimited", async () => {
    const tokens = content("app/Support/StrapiTransferTokens.php");
    expect(tokens).toContain("public const PERMISSIONS = ['push', 'pull'];");
    expect(tokens).toContain(
      "public const LIFESPANS = [7 * 86400000, 30 * 86400000, 90 * 86400000];",
    );
    await expect(tokens).toMatchFileSnapshot("./__golden__/strapi-api/StrapiTransferTokens.php");
  });

  it("answers Strapi's runner routes beside /api, so route:cache keeps them", async () => {
    const routes = content("routes/transfer.php");
    expect(routes).toContain(
      "Route::get('/admin/transfer/runner/push', [StrapiTransferRunner::class, 'push']);",
    );
    expect(routes).toContain(
      "Route::get('/admin/transfer/runner/pull', [StrapiTransferRunner::class, 'pull']);",
    );
    expect(routes).toContain("Route::middleware([StrapiErrors::class])->group(");
    await expect(routes).toMatchFileSnapshot("./__golden__/strapi-api/transfer-routes.php");
  });

  it("refuses a missing, expired or out-of-scope token before saying no socket is kept", async () => {
    const runner = content("app/Http/Controllers/Admin/StrapiTransferRunner.php");
    expect(runner).toContain(
      "throw new StrapiError(401, 'UnauthorizedError', 'Missing or invalid credentials');",
    );
    expect(runner).toContain("throw new StrapiError(403, 'ForbiddenError', 'Forbidden');");
    expect(runner).toContain("throw new StrapiError(501, 'NotImplementedError', ");
    expect(runner.indexOf("ForbiddenError")).toBeLessThan(runner.indexOf("NotImplementedError"));
    expect(content("app/Support/StrapiTransferTokens.php")).toContain(
      "throw new StrapiError(401, 'UnauthorizedError', 'Token expired');",
    );
    await expect(runner).toMatchFileSnapshot("./__golden__/strapi-api/StrapiTransferRunner.php");
  });

  it("reports the remote transfer a PHP host cannot serve", () => {
    const gap = result.gaps.gaps.find((g) => g.feature === "remoteDataTransfer");
    expect(gap?.severity).toBe("downgrade");
    expect(gap?.message).toContain("strapi:export");
  });

  it("lists the tokens in the admin's settings, showing a key once", () => {
    const resource = content("app/Filament/Resources/TransferTokens/TransferTokenResource.php");
    expect(resource).toContain("protected static ?string $navigationLabel = 'Transfer Tokens';");
    expect(resource).toContain("CheckboxList::make('permissions')");
    const create = content("app/Filament/Resources/TransferTokens/Pages/CreateTransferToken.php");
    expect(create).toContain("->title('Copy your transfer token')");
    const edit = content("app/Filament/Resources/TransferTokens/Pages/EditTransferToken.php");
    expect(edit).toContain("Action::make('regenerate')");
    expect(edit).not.toContain("Action::make('view')");
  });
});
