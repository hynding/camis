import { navigationProperties, SETTINGS } from "../admin/admin-navigation";
import { runtimePhp } from "../../runtime-php";

/**
 * Strapi's email plugin over Laravel's mailer: its settings (the provider's name, the default
 * sender and reply-to) and its send, shared by the admin's Email settings page and anything that
 * sends as Strapi's email service does. Laravel's MAIL_* settings choose the transport.
 */

export const STRAPI_EMAIL_PATH = "app/Support/StrapiEmail.php";
export const EMAIL_SETTINGS_PAGE_PATH = "app/Filament/Pages/EmailSettings.php";

/** config/camis.php's `email` keys; unset, each is Laravel's own mail setting. */
export const emailConfigKeys = (): string => `

    // Strapi's email plugin settings, shown on the admin's Email page. Unset, the provider is
    // Laravel's default mailer and the sender and reply-to are mail.from and mail.reply_to.
    'email' => [
        'provider' => env('CAMIS_EMAIL_PROVIDER'),
        'default_from' => env('CAMIS_EMAIL_DEFAULT_FROM'),
        'default_reply_to' => env('CAMIS_EMAIL_DEFAULT_REPLY_TO'),
    ],`;

export const emitStrapiEmail = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiEmail.php", import.meta.url));

export const EMAIL_CONTROLLER_PATH = "app/Http/Controllers/Api/EmailController.php";

/**
 * Strapi's email plugin's content API send (POST /api/email, plugin::email.email.send). Roles come
 * from the IR and none Strapi ships holds the action, so only an API token the StrapiApiToken
 * middleware has checked for it reaches the send.
 */
export const emitEmailController = (): string =>
  runtimePhp(new URL("./php/app/Http/Controllers/Api/EmailController.php", import.meta.url));

/** Strapi's Settings › Email › Configuration: the settings, read only, and a test email. */
export const emitEmailSettingsPage = (secured: boolean): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Pages;

use App\\Filament\\StrapiNavigation;
use App\\Support\\StrapiEmail;
use BackedEnum;
use Filament\\Actions\\Action;
use Filament\\Forms\\Components\\Placeholder;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Notifications\\Notification;
use Filament\\Pages\\Page;
use Filament\\Schemas\\Components\\Actions;
use Filament\\Schemas\\Components\\EmbeddedSchema;
use Filament\\Schemas\\Components\\Form;
use Filament\\Schemas\\Components\\Section;
use Filament\\Schemas\\Schema;
use UnitEnum;

/** The settings come from config (MAIL_* and CAMIS_EMAIL_*), so they are changed there, as in Strapi's config/plugins. */
class EmailSettings extends Page
{
    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-envelope';
${navigationProperties(SETTINGS.email)}
    protected static ?string $title = 'Configuration';

    public ?array $testData = [];

    public static function canAccess(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "true"};
    }

    public function mount(): void
    {
        $this->testForm->fill();
    }

    public function testForm(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('to')->label('Recipient email')->email()->required(),
        ])->statePath('testData');
    }

    public function content(Schema $schema): Schema
    {
        $settings = StrapiEmail::settings();

        return $schema->components([
            Section::make('Configuration')
                ->description('Configure your email plugin')
                ->columns(3)
                ->schema([
                    Placeholder::make('defaultFrom')->label('Default sender email')->content($settings['defaultFrom'] ?? '-'),
                    Placeholder::make('defaultReplyTo')->label('Default response email')->content($settings['defaultReplyTo'] ?? '-'),
                    Placeholder::make('provider')->label('Email provider')->content($settings['provider']),
                ]),
            Section::make('Test email delivery')
                ->schema([
                    Form::make([EmbeddedSchema::make('testForm')])
                        ->id('testForm')
                        ->livewireSubmitHandler('sendTest')
                        ->footer([Actions::make([Action::make('sendTest')->label('Send test email')->submit('sendTest')])]),
                ]),
        ]);
    }

    public function sendTest(): void
    {
        $to = (string) $this->testForm->getState()['to'];
        try {
            StrapiEmail::test($to);
        } catch (\\Throwable $error) {
            Notification::make()->danger()->title("Failed sending email to {$to}")->body($error->getMessage())->send();

            return;
        }
        Notification::make()->success()->title("Email test succeeded, check the {$to} mailbox")->send();
    }
}
`;
