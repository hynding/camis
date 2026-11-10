import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// The pages Strapi's admin has beside the Content Manager: its Home (the homepage widgets), and
// Settings › Overview, Media Library and Email.
describe("Strapi's Home and settings pages", () => {
  const strapi = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const paths = strapi.files.map((f) => f.path);
  const content = (p: string) => {
    const file = strapi.files.find((f) => f.path === p);
    if (file === undefined) throw new Error(`not generated: ${p}`);
    return file.content;
  };

  it("places Overview first in Settings, Media Library and Email where Strapi lists them", () => {
    const settings = [
      ["app/Filament/Pages/SettingsOverview.php", "Overview"],
      ["app/Filament/Resources/ApiTokens/ApiTokenResource.php", "API Tokens"],
      ["app/Filament/Resources/Locales/LocaleResource.php", "Internationalization"],
      ["app/Filament/Pages/MediaLibrarySettings.php", "Media Library"],
      ["app/Filament/Resources/TransferTokens/TransferTokenResource.php", "Transfer Tokens"],
      ["app/Filament/Resources/Webhooks/WebhookResource.php", "Webhooks"],
      ["app/Filament/Pages/DataTransfer.php", "Data transfer"],
      ["app/Filament/Pages/EmailSettings.php", "Email"],
      ["app/Filament/Resources/Roles/RoleResource.php", "Roles"],
    ] as const;
    const sorts = settings.map(([path, label]) => {
      const source = content(path);
      expect(source).toContain(
        "protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::Settings;",
      );
      expect(source).toContain(`protected static ?string $navigationLabel = '${label}';`);
      return Number(/\$navigationSort = (\d+);/.exec(source)?.[1]);
    });
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
  });

  describe("Home", () => {
    // Strapi's homepage widgets: Entries, Project statistics, Last edited and Last published.
    it("adds Strapi's homepage widgets to the dashboard", () => {
      for (const widget of [
        "StrapiEntries",
        "StrapiProjectStatistics",
        "StrapiLastEditedEntries",
        "StrapiLastPublishedEntries",
      ]) {
        expect(paths).toContain(`app/Filament/Widgets/${widget}.php`);
      }
      expect(content("app/Filament/Widgets/StrapiLastEditedEntries.php")).toContain(
        "->heading('Last edited entries')",
      );
      expect(content("app/Filament/Widgets/StrapiLastPublishedEntries.php")).toContain(
        "->heading('Last published entries')",
      );
    });

    it("reads every Content Manager type behind its read grant", async () => {
      const homepage = content("app/Support/StrapiHomepage.php");
      expect(homepage).toContain(
        "'api::post.post' => ['model' => \\App\\Models\\Post::class, 'resource' => \\App\\Filament\\Resources\\Posts\\PostResource::class, 'displayName' => 'Post', 'mainField' => 'title', 'read' => 'post.read', 'draftAndPublish' => true, 'localized' => false],",
      );
      // The users-permissions user is in the Content Manager, so it is on the homepage too.
      expect(homepage).toContain(
        "'plugin::users-permissions.user' => ['model' => \\App\\Models\\User::class, 'resource' => \\App\\Filament\\Resources\\Users\\UserResource::class, 'displayName' => 'User', 'mainField' => 'username', 'read' => 'user.read', 'draftAndPublish' => false, 'localized' => false],",
      );
      expect(homepage).toContain("return auth()->user()?->can($type['read']) ?? false;");
      // Strapi's widgets list four documents.
      expect(homepage).toContain("private const MAX_DOCUMENTS = 4;");
      await expect(homepage).toMatchFileSnapshot("./__golden__/strapi-api/StrapiHomepage.php");
    });

    // Strapi's key statistics: its components count is of their categories.
    it("counts what Strapi's Project statistics count", () => {
      const homepage = content("app/Support/StrapiHomepage.php");
      expect(homepage).toContain("'assets' => \\App\\Models\\File::query()->count(),");
      expect(homepage).toContain("'locales' => \\App\\Models\\Locale::query()->count(),");
      expect(homepage).toContain("'apiTokens' => \\App\\Models\\StrapiApiToken::query()->count(),");
      expect(homepage).toContain("'webhooks' => \\App\\Models\\StrapiWebhook::query()->count(),");
      expect(homepage).toMatch(/'components' => \d+,/);
    });
  });

  describe("Settings › Overview", () => {
    it("shows the application's details", () => {
      const page = content("app/Filament/Pages/SettingsOverview.php");
      expect(page).toContain("protected static ?string $title = 'Overview';");
      expect(page).toContain("app()->version()");
      expect(page).toContain("PHP_VERSION");
      expect(page).toContain("InstalledVersions::getPrettyVersion('filament/filament')");
    });
  });

  describe("Settings › Media Library", () => {
    it("edits Strapi's upload settings in the store, behind the settings grant", () => {
      const page = content("app/Filament/Pages/MediaLibrarySettings.php");
      expect(page).toContain(
        "Toggle::make('responsiveDimensions')->label('Responsive friendly upload')",
      );
      expect(page).toContain("Toggle::make('sizeOptimization')->label('Size optimization')");
      expect(page).toContain("Toggle::make('autoOrientation')->label('Auto orientation')");
      expect(page).toContain(
        "StrapiSettings::merge(StrapiUpload::SETTINGS_KEY, $state['settings']);",
      );
      expect(page).toContain("return auth()->user()?->can('user.update') ?? false;");
    });

    // Strapi's defaults: formats on, size optimization on, auto orientation off.
    it("makes uploads follow them", () => {
      const upload = content("app/Support/StrapiUpload.php");
      expect(upload).toContain(
        "public const DEFAULT_SETTINGS = ['sizeOptimization' => true, 'responsiveDimensions' => true, 'autoOrientation' => false, 'aiMetadata' => true];",
      );
      expect(upload).toContain("$settings['responsiveDimensions']");
      expect(upload).toContain("private static function optimize(");
    });

    // An archive carries them as Strapi's core store does.
    it("carries them through strapi:export and strapi:import", () => {
      expect(content("app/Support/StrapiImport.php")).toContain(
        "'plugin_upload_settings' => 'upload.settings',",
      );
      expect(content("app/Support/StrapiExport.php")).toContain(
        "$store('plugin_upload_settings', \\App\\Support\\StrapiUpload::settings());",
      );
    });
  });

  describe("Settings › Email", () => {
    it("reads Strapi's email settings from config, falling back to Laravel's mailer", async () => {
      const config = content("config/camis.php");
      expect(config).toContain("'provider' => env('CAMIS_EMAIL_PROVIDER'),");
      expect(config).toContain("'default_from' => env('CAMIS_EMAIL_DEFAULT_FROM'),");
      expect(config).toContain("'default_reply_to' => env('CAMIS_EMAIL_DEFAULT_REPLY_TO'),");
      const email = content("app/Support/StrapiEmail.php");
      expect(email).toContain("config('mail.default')");
      expect(email).toContain("config('mail.from.address')");
      expect(email).toContain("public static function send(array $options): void");
      await expect(email).toMatchFileSnapshot("./__golden__/strapi-api/StrapiEmail.php");
    });

    it("shows the configuration and sends Strapi's test email", () => {
      const page = content("app/Filament/Pages/EmailSettings.php");
      expect(page).toContain("Placeholder::make('defaultFrom')->label('Default sender email')");
      expect(page).toContain(
        "Placeholder::make('defaultReplyTo')->label('Default response email')",
      );
      expect(page).toContain("Placeholder::make('provider')->label('Email provider')");
      expect(page).toContain(
        "TextInput::make('to')->label('Recipient email')->email()->required()",
      );
      expect(page).toContain("StrapiEmail::test($to);");
      expect(content("app/Support/StrapiEmail.php")).toContain(
        "'subject' => \"Strapi test mail to: {$to}\",",
      );
      expect(page).toContain("return auth()->user()?->can('user.update') ?? false;");
    });
  });

  it("leaves Media Library out of a project without the media library", () => {
    const noMedia = filamentAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            { name: "Tag", kind: "collection", fields: [{ type: "integer", name: "rank" }] },
          ],
          components: [],
        },
        roles: [],
      },
      { projectName: "tags", apiStyle: "strapi" },
    );
    const files = noMedia.files.map((f) => f.path);
    expect(files).not.toContain("app/Filament/Pages/MediaLibrarySettings.php");
    expect(files).toContain("app/Filament/Pages/EmailSettings.php");
    const homepage = noMedia.files.find(
      (f) => f.path === "app/Support/StrapiHomepage.php",
    )!.content;
    expect(homepage).not.toContain("'assets' =>");
    // A type with no string field shows its id, as Strapi's default main field; with no roles,
    // every type is read.
    expect(homepage).toContain("'mainField' => 'id'");
    expect(homepage).toContain("'admins' => \\App\\Models\\AdminUser::query()->count(),");
  });
});
