import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// strapi:export and strapi:import from the admin, for a shared host with no shell: the same engines
// the commands run, an archive downloaded through a signed link (streamed, not held in memory) and
// one uploaded, or put in storage/app/private/strapi-transfer by FTP when it is larger than PHP
// takes in a request.
describe("the Data transfer page", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;
  const page = content("app/Filament/Pages/DataTransfer.php");

  it("exports and imports with the commands' engines and options", async () => {
    expect(page).toContain("StrapiExport::write(");
    expect(page).toContain("StrapiImport::open(");
    expect(page).toContain("->schemaDiffs()");
    expect(page).toContain("CheckboxList::make('exclude')");
    await expect(page).toMatchFileSnapshot("./__golden__/strapi-api/DataTransfer.php");
  });

  it("asks before an import replaces the content", () => {
    expect(page).toContain(
      "->modalDescription('The import will delete your existing data! Are you sure you want to proceed?')",
    );
  });

  it("is for whoever may change accounts", () => {
    expect(page).toContain("return auth()->user()?->can('user.update') ?? false;");
  });

  it("hands an export over through a link that expires and names one archive", async () => {
    const routes = content("routes/transfer.php");
    expect(routes).toContain(
      "Route::get('/admin/data-transfer/{file}', StrapiTransferDownload::class)",
    );
    expect(routes).toContain("->middleware('signed')");
    expect(routes).toContain("->where('file', '[A-Za-z0-9][A-Za-z0-9_.-]*')");
    expect(page).toContain("URL::temporarySignedRoute('camis.data-transfer.download'");
    const archives = content("app/Support/StrapiTransferArchives.php");
    expect(archives).toContain("storage_path('app/private/strapi-transfer')");
    await expect(archives).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiTransferArchives.php",
    );
  });
});
