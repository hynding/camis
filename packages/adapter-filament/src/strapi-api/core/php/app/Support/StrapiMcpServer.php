<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use Throwable;

/**
 * Strapi 5's MCP server, as one admin token sees it: the JSON-RPC methods Strapi answers
 * (initialize, ping, logging/setLevel, tools/list, tools/call), the tools the token's permissions
 * reach, each call's arguments checked against the tool's schema and its handler's failure
 * reported as a tool error. Every request is answered on its own: the server keeps no session.
 */
final class StrapiMcpServer
{
    public const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

    private const DEFINITIONS = 'strapi/mcp.json';

    /** Strapi's own tool a client may only use while Strapi runs in development. */
    private const DEVELOPMENT_TOOLS = ['log'];

    /** @var array{types: array<string, array<string, mixed>>, tools: list<array<string, mixed>>}|null */
    private static ?array $definitions = null;

    public function __construct(private readonly StrapiAdminToken $token, private readonly AdminUser $owner)
    {
    }

    /**
     * The answer to one JSON-RPC message, or null for a notification.
     *
     * @param  array<string, mixed>  $message
     * @return array<string, mixed>|null
     */
    public function handle(array $message): ?array
    {
        if (! array_key_exists('id', $message) || ! isset($message['method'])) {
            return null;
        }
        $id = $message['id'];
        $params = is_array($message['params'] ?? null) ? $message['params'] : [];
        try {
            $result = match ($message['method']) {
                'initialize' => $this->initialize($params),
                'ping', 'logging/setLevel' => new \stdClass(),
                'tools/list' => ['tools' => $this->listed()],
                'tools/call' => $this->call($params),
                default => throw new StrapiMcpError(-32601, 'Method not found'),
            };
        } catch (StrapiMcpError $error) {
            return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $error->getCode(), 'message' => $error->getMessage()]];
        }

        return ['result' => $result, 'jsonrpc' => '2.0', 'id' => $id];
    }

    /** @return array<string, mixed> */
    private function initialize(array $params): array
    {
        $requested = $params['protocolVersion'] ?? null;

        return [
            'protocolVersion' => in_array($requested, self::SUPPORTED_PROTOCOL_VERSIONS, true) ? $requested : self::SUPPORTED_PROTOCOL_VERSIONS[0],
            'capabilities' => ['logging' => new \stdClass(), 'tools' => ['listChanged' => true]],
            'serverInfo' => ['name' => 'strapi-mcp-server', 'version' => '1.0.0'],
        ];
    }

    /** @return array<string, mixed> */
    private function call(array $params): array
    {
        $name = (string) ($params['name'] ?? '');
        $tool = null;
        foreach (self::definitions()['tools'] as $candidate) {
            if ($candidate['name'] === $name) {
                $tool = $candidate;
            }
        }
        if ($tool === null && ! in_array($name, self::DEVELOPMENT_TOOLS, true)) {
            throw new StrapiMcpError(-32602, "Tool {$name} not found");
        }
        if ($tool === null || ! $this->may($tool)) {
            throw new StrapiMcpError(-32602, "Tool {$name} disabled");
        }
        $tool = $this->served($tool);
        [$arguments, $issues] = StrapiMcpSchema::validate($tool['inputSchema'], $params['arguments'] ?? []);
        if ($issues !== []) {
            return self::failed("Input validation error: Invalid arguments for tool {$name}: ".implode(', ', $issues));
        }
        try {
            $structured = StrapiMcpContentManager::call($tool, self::definitions()['types'][$tool['uid']], $arguments, $this->owner);
        } catch (StrapiMcpError|StrapiError $error) {
            return self::failed("Tool \"{$name}\" execution failed: {$error->getMessage()}");
        } catch (Throwable $error) {
            report($error);

            return self::failed("Tool \"{$name}\" execution failed: Internal Server Error");
        }
        $json = json_encode($structured, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);

        return ['content' => [['type' => 'text', 'text' => (string) $json]], 'structuredContent' => $structured];
    }

    /** @return array<string, mixed> */
    private static function failed(string $text): array
    {
        return ['content' => [['type' => 'text', 'text' => $text]], 'isError' => true];
    }

    /**
     * The tools the token may use, as tools/list shows them: read again as objects, so that an
     * empty schema stays `{}`.
     *
     * @return list<\stdClass>
     */
    private function listed(): array
    {
        $objects = json_decode((string) file_get_contents(resource_path(self::DEFINITIONS)), false, flags: JSON_THROW_ON_ERROR);
        $listed = [];
        foreach (self::definitions()['tools'] as $i => $tool) {
            if (! $this->may($tool)) {
                continue;
            }
            $object = $objects->tools[$i];
            if (($tool['localized'] ?? false) === true && isset($object->inputSchema->properties->locale)) {
                $object->inputSchema->properties->locale = (object) self::localeSchema();
            }
            $listed[] = (object) [
                'name' => $object->name,
                'title' => $object->title,
                'description' => $object->description,
                'inputSchema' => $object->inputSchema,
                'outputSchema' => $object->outputSchema,
            ];
        }

        return $listed;
    }

    /** Every action the tool's policies name, given to the token and still held by its owner. */
    private function may(array $tool): bool
    {
        foreach ($tool['policies'] as $policy) {
            $keys = StrapiAdminPermissions::fromStrapi([$policy]);
            $held = array_filter($keys, fn (string $key): bool => StrapiAdminTokens::allows($this->token, $this->owner, $key));
            if ($held === []) {
                return false;
            }
        }

        return true;
    }

    /** A localized type's locale is one of the installed locales, the default one when left out. */
    private function served(array $tool): array
    {
        if (($tool['localized'] ?? false) === true && isset($tool['inputSchema']['properties']['locale'])) {
            $tool['inputSchema']['properties']['locale'] = self::localeSchema();
        }

        return $tool;
    }

    /** @return array<string, mixed> */
    private static function localeSchema(): array
    {
        $codes = self::localeCodes();
        $default = StrapiLocales::default();
        $defaults = in_array($default, $codes, true);

        return [
            ...($defaults ? ['default' => $default] : []),
            'description' => 'Locale code. Available: '.implode(', ', $codes).'. '.($defaults ? "Defaults to \"{$default}\"." : 'Defaults to the default locale.'),
            'type' => 'string',
            'enum' => $codes,
        ];
    }

    /** @return list<string> */
    private static function localeCodes(): array
    {
        $codes = \App\Models\Locale::query()->orderBy('id')->pluck('code')->all();

        return $codes === [] ? [StrapiLocales::default()] : array_values(array_map('strval', $codes));
    }

    /** @return array{types: array<string, array<string, mixed>>, tools: list<array<string, mixed>>} */
    private static function definitions(): array
    {
        return self::$definitions ??= json_decode((string) file_get_contents(resource_path(self::DEFINITIONS)), true, flags: JSON_THROW_ON_ERROR);
    }
}
