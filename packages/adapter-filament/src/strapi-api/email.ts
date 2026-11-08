import { PHP_MARKER } from "../hooks/names";
import { navigationProperties, SETTINGS } from "./admin-navigation";

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

export const emitStrapiEmail = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Mail\\Message;
use Illuminate\\Support\\Facades\\Mail;

/** Strapi's email service: its settings, and a send that fills the sender and reply-to from them. */
final class StrapiEmail
{
    /** @return array{provider: string, defaultFrom: ?string, defaultReplyTo: ?string} */
    public static function settings(): array
    {
        return [
            'provider' => (string) (self::filled(config('camis.email.provider')) ?? config('mail.default')),
            'defaultFrom' => self::filled(config('camis.email.default_from')) ?? self::filled(config('mail.from.address')),
            'defaultReplyTo' => self::filled(config('camis.email.default_reply_to')) ?? self::filled(config('mail.reply_to.address')),
        ];
    }

    /**
     * Sends as Strapi's email service does: to, cc, bcc, from, replyTo, subject, text and html,
     * each address a string (comma separated for several) or a list.
     *
     * @param array<string, mixed> $options
     */
    public static function send(array $options): void
    {
        $settings = self::settings();
        $from = self::filled($options['from'] ?? null) ?? $settings['defaultFrom'];
        $replyTo = self::filled($options['replyTo'] ?? null) ?? $settings['defaultReplyTo'];
        Mail::send([], [], function (Message $message) use ($options, $from, $replyTo): void {
            $message->to(self::addresses($options['to'] ?? null));
            foreach (['cc', 'bcc'] as $copy) {
                if (self::addresses($options[$copy] ?? null) !== []) {
                    $message->{$copy}(self::addresses($options[$copy]));
                }
            }
            if ($from !== null) {
                $message->from($from);
            }
            if ($replyTo !== null) {
                $message->replyTo($replyTo);
            }
            $message->subject((string) ($options['subject'] ?? ''));
            if (self::filled($options['html'] ?? null) !== null) {
                $message->html((string) $options['html']);
            }
            if (self::filled($options['text'] ?? null) !== null) {
                $message->text((string) $options['text']);
            }
        });
    }

    /** The test email Strapi's Email settings page sends, word for word. */
    public static function test(string $to): void
    {
        $provider = self::settings()['provider'];
        self::send([
            'to' => $to,
            'subject' => "Strapi test mail to: {$to}",
            'text' => "Great! You have correctly configured the Strapi email plugin with the {$provider} provider. \\r\\nFor documentation on how to use the email plugin checkout: https://docs.strapi.io/developer-docs/latest/plugins/email.html",
        ]);
    }

    /** @return list<string> */
    private static function addresses(mixed $value): array
    {
        $list = is_array($value) ? $value : explode(',', (string) $value);

        return array_values(array_filter(array_map(fn (mixed $address): string => trim((string) $address), $list), fn (string $address): bool => $address !== ''));
    }

    private static function filled(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? $value : null;
    }
}
`;

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
