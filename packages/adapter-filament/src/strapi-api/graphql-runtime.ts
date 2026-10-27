import { PHP_MARKER } from "../hooks/names";
import type { GraphqlSchema } from "./graphql-schema";

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\GraphQL;\n`;

/** The schema's path, relative to the application, which the runtime reads and caches. */
export const GRAPHQL_SCHEMA_PATH = "graphql/schema.graphql";

const phpString = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const phpBool = (value: boolean): string => (value ? "true" : "false");

/** The per-project half: which content type and action each root field is, and how types link. */
export const emitStrapiGraphqlTypes = (schema: GraphqlSchema, tokens: boolean): string => {
  const roots = (rows: [string, string, string][]) =>
    rows
      .map(([field, type, action]) => `        '${field}' => ['${type}', '${action}'],`)
      .join("\n");
  const nested = (entries: Record<string, { type: string; repeatable: boolean }>) =>
    Object.entries(entries)
      .map(
        ([k, v]) => `'${k}' => ['type' => '${v.type}', 'repeatable' => ${phpBool(v.repeatable)}]`,
      )
      .join(", ");
  const types = schema.types
    .map(
      (t) => `        '${t.name}' => [
            'controller' => ${t.name === "UploadFile" ? "null" : `\\App\\Http\\Controllers\\Api\\${t.model}ApiController::class`},
            'routeKey' => ${t.routeKey === null ? "null" : phpString(t.routeKey)},
            'draftPublish' => ${phpBool(t.draftPublish)},
            'localized' => ${phpBool(t.localized)},
            'relations' => [${Object.entries(t.relations)
              .map(([k, r]) => `'${k}' => ['type' => '${r.type}', 'many' => ${phpBool(r.many)}]`)
              .join(", ")}],
            'components' => [${nested(t.components)}],
            'zones' => [${t.zones.map(phpString).join(", ")}],
        ],`,
    )
    .join("\n");
  const components = schema.components
    .map(
      (c) =>
        `        '${c.name}' => ['uid' => ${phpString(c.uid)}, 'components' => [${nested(c.components)}]],`,
    )
    .join("\n");
  const plugins = schema.plugins
    .map(([field, action]) => `        '${field}' => '${action}',`)
    .join("\n");
  const roles = schema.roles
    .map(
      (r) =>
        `        ${phpString(r.type)} => ['name' => ${phpString(r.name)}, 'description' => ${r.description === null ? "null" : phpString(r.description)}],`,
    )
    .join("\n");
  const morphs = schema.types
    .filter((t) => t.name !== "UploadFile")
    .map((t) => `        ${phpString(t.uid)} => '${t.name}',`)
    .join("\n");
  const zones = Object.entries(schema.zoneMembers)
    .map(([union, members]) => `        '${union}' => [${members.map(phpString).join(", ")}],`)
    .join("\n");
  return `${header}
/** What graphql/schema.graphql's types are on the REST API (StrapiGraphql resolves through it). */
final class StrapiGraphqlTypes
{
    /** Query field → [content type, action]. */
    public const QUERIES = [
${roots(schema.queries)}
    ];

    /** Mutation field → [content type, action]. */
    public const MUTATIONS = [
${roots(schema.mutations)}
    ];

    /** Content type → its REST controller, and the keys that are relations, components and zones. */
    public const TYPES = [
${types}
    ];

    /** Component type → its uid and its own components. */
    public const COMPONENTS = [
${components}
    ];

    /** A dynamic zone's union → the component types it holds. */
    public const ZONES = [
${zones}
    ];

    /** A content type's uid → its type, for the GenericMorph entries a file is linked from. */
    public const MORPHS = [
${morphs}
    ];

    /** A plugin's root field → what StrapiGraphqlPlugins answers it with. */
    public const PLUGINS = [
${plugins}
    ];

    /** The IR's roles as users-permissions shows them, by type (the role's own name). */
    public const ROLES = [
${roles}
    ];

    /** Whether the project keeps API tokens, which StrapiGraphql checks each action against. */
    public const TOKENS = ${phpBool(tokens)};
}
`;
};

/**
 * Strapi 5's GraphQL content API (its graphql plugin) over the generated REST controllers: each
 * root field is the REST action it names, run with the caller's own credentials, so its grants,
 * row conditions, draft and publish, locales and validation are the REST API's own. The
 * selection set becomes the request's populate, so a list costs what the REST list costs; a
 * relation asked for twice with different arguments is fetched per row for the second ask.
 * `graphql-vectors.json`, recorded from strapi-php, is the check.
 *
 * Shared hosting: the printed schema is parsed once and kept in bootstrap/cache as a PHP array,
 * which opcache serves from then on; no process outlives a request.
 */
export const emitStrapiGraphql = (): string =>
  header +
  String.raw`
use App\Support\StrapiApiTokens;
use App\Support\StrapiError;
use GraphQL\Error\Error;
use GraphQL\Error\SyntaxError;
use GraphQL\Executor\Values;
use GraphQL\GraphQL;
use GraphQL\Language\AST\FieldNode;
use GraphQL\Language\AST\FragmentSpreadNode;
use GraphQL\Language\AST\InlineFragmentNode;
use GraphQL\Language\AST\IntValueNode;
use GraphQL\Language\AST\Node;
use GraphQL\Language\AST\OperationDefinitionNode;
use GraphQL\Language\AST\SelectionSetNode;
use GraphQL\Language\AST\StringValueNode;
use GraphQL\Language\Parser;
use GraphQL\Type\Definition\Directive;
use GraphQL\Type\Definition\InputObjectType;
use GraphQL\Type\Definition\ListOfType;
use GraphQL\Type\Definition\ObjectType;
use GraphQL\Type\Definition\ResolveInfo;
use GraphQL\Type\Definition\Type;
use GraphQL\Type\Schema;
use GraphQL\Utils\AST;
use GraphQL\Utils\BuildSchema;
use GraphQL\Validator\DocumentValidator;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

final class StrapiGraphql
{
    private const SCHEMA = '${GRAPHQL_SCHEMA_PATH}';

    private const CACHE = 'bootstrap/cache/camis-graphql.php';

    /** Where a row keeps what its own relations were fetched with, for the fields that read them. */
    private const META = '__camis';

    private const VERBS = ['index' => 'GET', 'show' => 'GET', 'store' => 'POST', 'update' => 'PUT', 'destroy' => 'DELETE'];

    private static ?Schema $schema = null;

    public function __invoke(Request $request): JsonResponse
    {
        $input = $request->isMethod('GET') ? $request->query() : $request->json()->all();
        $query = $input['query'] ?? null;
        $variables = $input['variables'] ?? null;
        if (is_string($variables)) {
            $variables = json_decode($variables, true);
        }
        if (! is_string($query) || trim($query) === '') {
            return self::refused('GraphQL operations must contain a non-empty ` +
  "`query`" +
  String.raw`.', 'BAD_REQUEST');
        }
        try {
            $document = Parser::parse($query);
        } catch (SyntaxError $e) {
            return self::refused($e->getMessage(), 'GRAPHQL_PARSE_FAILED');
        }
        $schema = self::schema();
        $invalid = DocumentValidator::validate($schema, $document);
        if ($invalid !== []) {
            return response()->json(['errors' => array_map(fn (Error $e) => self::format($e, 'GRAPHQL_VALIDATION_FAILED'), $invalid)], 400);
        }
        if ($request->isMethod('GET') && self::mutates($document, $input['operationName'] ?? null)) {
            return self::refused('Mutations are not allowed over GET', 'BAD_REQUEST', 405);
        }
        $result = GraphQL::executeQuery(
            $schema,
            $document,
            null,
            $request,
            is_array($variables) ? $variables : null,
            is_string($input['operationName'] ?? null) ? $input['operationName'] : null,
            self::resolve(...),
            [],
        );
        $result->setErrorFormatter(fn (Error $e) => self::format($e));

        return response()->json($result->toArray(), $result->data === null && $result->errors !== [] && ! self::executed($result->errors) ? 400 : 200);
    }

    // -------------------------------------------------------------------------------- schema

    /** The printed schema with its scalars and unions bound, parsed once per deploy. */
    public static function schema(): Schema
    {
        if (self::$schema !== null) {
            return self::$schema;
        }
        $source = base_path(self::SCHEMA);
        $cache = base_path(self::CACHE);
        $hash = (string) md5_file($source);
        $cached = is_file($cache) ? require $cache : null;
        if (is_array($cached) && ($cached['hash'] ?? null) === $hash) {
            $document = AST::fromArray($cached['ast']);
        } else {
            $document = Parser::parse((string) file_get_contents($source), ['noLocation' => true]);
            @file_put_contents($cache, '<?php return '.var_export(['hash' => $hash, 'ast' => AST::toArray($document)], true).';', LOCK_EX);
        }

        return self::$schema = BuildSchema::build($document, self::decorate(...), ['assumeValidSDL' => true]);
    }

    private static function decorate(array $config, Node $node): array
    {
        $name = $config['name'];
        if (isset(StrapiGraphqlTypes::ZONES[$name])) {
            $config['resolveType'] = fn (mixed $item) => self::componentType(is_array($item) ? ($item['__component'] ?? null) : null) ?? 'Error';

            return $config;
        }
        if ($name === 'GenericMorph') {
            $config['resolveType'] = fn (mixed $entry) => StrapiGraphqlTypes::MORPHS[is_array($entry) ? ($entry['__type'] ?? '') : ''] ?? null;

            return $config;
        }
        $scalar = match (true) {
            $name === 'Long' => self::long(),
            in_array($name, ['DateTime', 'Date', 'Time', 'I18NLocaleCode'], true) => self::text($name),
            $name === 'JSON', str_ends_with($name, 'DynamicZoneInput') => self::json(),
            default => null,
        };

        return $scalar === null ? $config : $scalar + $config;
    }

    /** Strapi's Long: a whole number, sent as one (the REST wire sends it as a string). */
    private static function long(): array
    {
        $number = function (mixed $value): int|string {
            if (is_int($value)) {
                return $value;
            }
            if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
                return (string) (int) $value === $value ? (int) $value : $value;
            }
            throw new Error('Long cannot represent a non-integer value: '.json_encode($value));
        };

        return [
            'serialize' => $number,
            'parseValue' => $number,
            'parseLiteral' => fn (Node $node) => $node instanceof IntValueNode || $node instanceof StringValueNode
                ? $number($node->value)
                : throw new Error('Long cannot represent a non-integer value'),
        ];
    }

    private static function text(string $name): array
    {
        $string = fn (mixed $value) => is_string($value) ? $value : throw new Error("{$name} cannot represent a non-string value");

        return [
            'serialize' => fn (mixed $value) => is_scalar($value) ? (string) $value : $string($value),
            'parseValue' => $string,
            'parseLiteral' => fn (Node $node) => $node instanceof StringValueNode ? $node->value : throw new Error("{$name} cannot represent a non-string value"),
        ];
    }

    private static function json(): array
    {
        return [
            'serialize' => fn (mixed $value) => $value,
            'parseValue' => fn (mixed $value) => $value,
            'parseLiteral' => fn (Node $node, ?array $variables = null) => AST::valueFromASTUntyped($node, $variables),
        ];
    }

    private static function componentType(mixed $uid): ?string
    {
        foreach (StrapiGraphqlTypes::COMPONENTS as $type => $component) {
            if ($component['uid'] === $uid) {
                return $type;
            }
        }

        return null;
    }

    // ----------------------------------------------------------------------------- resolving

    public static function resolve(mixed $source, array $args, Request $request, ResolveInfo $info): mixed
    {
        $parent = $info->parentType->name;
        if ($parent === 'Query' || $parent === 'Mutation') {
            return self::root($parent, $args, $request, $info);
        }
        if (! is_array($source)) {
            return null;
        }
        if (isset(StrapiGraphqlPlugins::RELATIONS[$parent])) {
            return StrapiGraphqlPlugins::field($source, $args, $request, $info);
        }
        $name = $info->fieldName;
        if ($parent === 'UploadFile' && $name === 'related' && ! array_key_exists('related', $source)) {
            return StrapiGraphqlPlugins::related($source, $request);
        }
        $type = StrapiGraphqlTypes::TYPES[$parent] ?? StrapiGraphqlTypes::COMPONENTS[$parent] ?? [];
        $key = str_ends_with($name, '_connection') ? substr($name, 0, -strlen('_connection')) : $name;
        if (isset($type['relations'][$key])) {
            return self::related($source, $parent, $key, $key !== $name, $args, $request, $info);
        }
        if ($type['components'][$name]['repeatable'] ?? false) {
            if (($args['filters'] ?? null) !== null || ($args['sort'] ?? []) !== []) {
                throw StrapiError::validation('Filters and sort on a repeatable component are not supported');
            }

            return self::page($source[$name] ?? [], $args['pagination'] ?? []);
        }

        return $source[$name] ?? null;
    }

    private static function root(string $root, array $args, Request $request, ResolveInfo $info): mixed
    {
        $plugin = StrapiGraphqlTypes::PLUGINS[$info->fieldName] ?? null;
        if ($plugin !== null) {
            return StrapiGraphqlPlugins::root($plugin, $args, $request, $info);
        }
        [$typeName, $action] = ($root === 'Query' ? StrapiGraphqlTypes::QUERIES : StrapiGraphqlTypes::MUTATIONS)[$info->fieldName];
        $type = StrapiGraphqlTypes::TYPES[$typeName];
        $nodes = $action === 'connection' ? self::nodes($info->fieldNodes, Type::getNamedType($info->returnType)->name, $info) : $info->fieldNodes;
        $deletes = $action === 'delete' || $action === 'deleteSingle';
        [$populate, $claims] = $deletes ? [[], ['claims' => [], 'children' => []]] : self::populate($typeName, $nodes, $info);
        $params = ['populate' => $populate];
        if ($type['draftPublish'] && ! $deletes) {
            $params['status'] = strtolower((string) ($args['status'] ?? 'PUBLISHED'));
        }
        if (isset($args['locale'])) {
            $params['locale'] = $args['locale'];
        }
        $cohort = self::cohort($args);
        if ($cohort !== null && ! $deletes) {
            $params['publicationFilter'] = $cohort;
        }
        $context = ['status' => $params['status'] ?? null, 'locale' => $params['locale'] ?? null, 'cohort' => $params['publicationFilter'] ?? null];
        $key = isset($args['documentId']) ? self::routeKey($type, (string) $args['documentId'], $params, $request) : null;
        $one = fn (?array $body) => $body === null ? null : self::annotate($body['data'], $typeName, $claims, $context);

        switch ($action) {
            case 'find':
            case 'connection':
                $params += self::listing($args, $info->fieldDefinition->getArg('filters')?->getType());
                $params['pagination']['withCount'] = $action === 'connection';
                $body = self::call($type, 'index', $params, $request);
                $rows = array_map(fn (array $wire) => self::annotate($wire, $typeName, $claims, $context), $body['data']);

                return $action === 'find' ? $rows : ['nodes' => $rows, 'pageInfo' => self::pageInfo($body['meta']['pagination'] ?? [])];
            case 'findOne':
                return $key === null ? null : $one(self::found(fn () => self::call($type, 'show', $params, $request, null, $key)));
            case 'create':
                return $one(self::call($type, 'store', $params, $request, self::data($type, $args['data'] ?? [])));
            case 'update':
                return $key === null ? null : $one(self::found(fn () => self::call($type, 'update', $params, $request, self::data($type, $args['data'] ?? []), $key)));
            case 'findSingle':
                return $one(self::found(fn () => self::call($type, 'single', $params, $request)));
            case 'updateSingle':
                return $one(self::call($type, 'putSingle', $params, $request, self::data($type, $args['data'] ?? [])));
            case 'deleteSingle':
                // Strapi answers with the entry it found, after the caller's grant is checked.
                $documentId = app($type['controller'])->singleDocumentId();
                self::call($type, 'destroySingle', $params, $request);
                if ($documentId === null) {
                    throw new StrapiError(404, 'NotFoundError', 'Document not found');
                }

                return ['documentId' => $documentId];
            default:
                if ($key !== null) {
                    self::found(fn () => self::call($type, 'destroy', $params, $request, null, $key));
                }

                return ['documentId' => (string) $args['documentId']];
        }
    }

    /** A relation's value: the row's own populate when it fetched this ask, else fetched for the row. */
    private static function related(array $source, string $parent, string $key, bool $connection, array $args, Request $request, ResolveInfo $info): mixed
    {
        $relation = StrapiGraphqlTypes::TYPES[$parent]['relations'][$key];
        $fetch = self::fetching($args, $info->fieldDefinition->getArg('filters')?->getType());
        $meta = $source[self::META] ?? null;
        if (is_array($meta) && ($meta['claims']['claims'][$key] ?? null) === $fetch && array_key_exists($key, $source)) {
            $value = $source[$key];
        } else {
            $value = self::refetch($source, $parent, $key, $fetch, $connection, $request, $info);
        }
        if (! $relation['many']) {
            return $value;
        }
        $items = self::page(is_array($value) ? $value : [], $args['pagination'] ?? []);

        return $connection ? ['nodes' => $items] : $items;
    }

    /** One row's relation, fetched through its own type's REST show with this ask's populate. */
    private static function refetch(array $source, string $parent, string $key, array $fetch, bool $connection, Request $request, ResolveInfo $info): mixed
    {
        $type = StrapiGraphqlTypes::TYPES[$parent];
        $meta = $source[self::META] ?? [];
        if ($type['controller'] === null || ! isset($source['documentId'])) {
            return null;
        }
        $target = $type['relations'][$key]['type'];
        $nodes = $connection ? self::nodes($info->fieldNodes, Type::getNamedType($info->returnType)->name, $info) : $info->fieldNodes;
        [$populate, $claims] = self::populate($target, $nodes, $info);
        $params = ['populate' => [$key => array_filter($fetch, fn ($v) => $v !== null && $v !== []) + ($populate === [] ? [] : ['populate' => $populate])]];
        if ($type['draftPublish'] && ($meta['status'] ?? null) !== null) {
            $params['status'] = $meta['status'];
        }
        $locale = $source['locale'] ?? $meta['locale'] ?? null;
        if ($type['localized'] && $locale !== null) {
            $params['locale'] = $locale;
        }
        if (($meta['cohort'] ?? null) !== null) {
            $params['publicationFilter'] = $meta['cohort'];
        }
        $id = self::routeKey($type, (string) $source['documentId'], $params, $request);
        $body = $id === null ? null : self::found(fn () => self::call($type, 'show', $params, $request, null, $id));
        $value = $body['data'][$key] ?? null;
        $context = ['status' => $meta['status'] ?? null, 'locale' => $meta['locale'] ?? null, 'cohort' => $meta['cohort'] ?? null];
        if (! is_array($value)) {
            return $value;
        }

        return $type['relations'][$key]['many']
            ? array_map(fn (array $wire) => self::annotate($wire, $target, $claims, $context), $value)
            : self::annotate($value, $target, $claims, $context);
    }

    // -------------------------------------------------------------------- selection → populate

    /**
     * The populate a selection asks for on $typeName, and what each relation was fetched with:
     * the first ask of a relation is populated with its own filters and sort, a second ask with
     * the same ones shares it, and one with others is left to refetch().
     *
     * @param iterable<FieldNode> $nodes
     * @return array{0: array, 1: array{claims: array, children: array}}
     */
    private static function populate(string $typeName, iterable $nodes, ResolveInfo $info): array
    {
        $object = $info->schema->getType($typeName);
        $meta = StrapiGraphqlTypes::TYPES[$typeName] ?? StrapiGraphqlTypes::COMPONENTS[$typeName] ?? [];
        $populate = [];
        $claims = ['claims' => [], 'children' => []];
        if (! $object instanceof ObjectType) {
            return [$populate, $claims];
        }
        foreach (self::collect($nodes, $typeName, $info) as $field) {
            $name = $field->name->value;
            $key = str_ends_with($name, '_connection') ? substr($name, 0, -strlen('_connection')) : $name;
            if (isset($meta['relations'][$key])) {
                $definition = $object->getField($name);
                $fetch = self::fetching(Values::getArgumentValues($definition, $field, $info->variableValues), $definition->getArg('filters')?->getType());
                $children = $key !== $name ? self::nodes([$field], Type::getNamedType($definition->getType())->name, $info) : [$field];
                [$inner, $innerClaims] = self::populate($meta['relations'][$key]['type'], $children, $info);
                if (! array_key_exists($key, $claims['claims'])) {
                    $claims['claims'][$key] = $fetch;
                    $claims['children'][$key] = $innerClaims;
                    $populate[$key] = array_filter($fetch, fn ($v) => $v !== null && $v !== []) + ($inner === [] ? [] : ['populate' => $inner]);
                } elseif ($claims['claims'][$key] === $fetch) {
                    $populate[$key]['populate'] = array_replace_recursive($populate[$key]['populate'] ?? [], $inner);
                    $claims['children'][$key] = array_replace_recursive($claims['children'][$key], $innerClaims);
                }
            } elseif (isset($meta['components'][$name]) || in_array($name, $meta['zones'] ?? [], true)) {
                $populate[$name] = in_array($name, $meta['zones'] ?? [], true) ? ['populate' => '*'] : true;
            }
        }

        return [$populate, $claims];
    }

    /**
     * The fields a selection asks for on $typeName, through its fragments, as GraphQL collects them.
     *
     * @param iterable<FieldNode> $nodes
     * @return list<FieldNode>
     */
    public static function collect(iterable $nodes, string $typeName, ResolveInfo $info): array
    {
        $fields = [];
        $walk = function (?SelectionSetNode $set) use (&$walk, &$fields, $typeName, $info): void {
            foreach ($set?->selections ?? [] as $selection) {
                if (! self::included($selection, $info)) {
                    continue;
                }
                if ($selection instanceof FieldNode) {
                    $fields[] = $selection;
                } elseif ($selection instanceof InlineFragmentNode) {
                    if ($selection->typeCondition === null || $selection->typeCondition->name->value === $typeName) {
                        $walk($selection->selectionSet);
                    }
                } elseif ($selection instanceof FragmentSpreadNode) {
                    $fragment = $info->fragments[$selection->name->value] ?? null;
                    if ($fragment !== null && $fragment->typeCondition->name->value === $typeName) {
                        $walk($fragment->selectionSet);
                    }
                }
            }
        };
        foreach ($nodes as $node) {
            $walk($node->selectionSet);
        }

        return $fields;
    }

    /**
     * The nodes fields of a connection's selections ($connection is its type), however aliased.
     *
     * @param iterable<FieldNode> $nodes
     * @return list<FieldNode>
     */
    public static function nodes(iterable $nodes, string $connection, ResolveInfo $info): array
    {
        return array_values(array_filter(self::collect($nodes, $connection, $info), fn (FieldNode $field) => $field->name->value === 'nodes'));
    }

    private static function included(Node $selection, ResolveInfo $info): bool
    {
        $skip = Values::getDirectiveValues(Directive::skipDirective(), $selection, $info->variableValues);
        $include = Values::getDirectiveValues(Directive::includeDirective(), $selection, $info->variableValues);

        return ! (($skip['if'] ?? false) === true) && ! (($include['if'] ?? true) === false);
    }

    /**
     * The root's publicationFilter as REST names it, or the deprecated hasPublishedVersion's
     * document-scoped cohort; Strapi hands either down to every draft-and-publish relation.
     */
    private static function cohort(array $args): ?string
    {
        if (($args['publicationFilter'] ?? null) !== null) {
            return str_replace('_', '-', strtolower((string) $args['publicationFilter']));
        }
        if (($args['hasPublishedVersion'] ?? null) === null) {
            return null;
        }

        return $args['hasPublishedVersion'] ? 'has-published-version-document' : 'never-published-document';
    }

    /** What a relation is fetched with: its filters, in REST's form, and its sort. */
    private static function fetching(array $args, ?Type $filters): array
    {
        return [
            'filters' => $filters === null || ($args['filters'] ?? null) === null ? null : self::filters($args['filters'], $filters),
            'sort' => $args['sort'] ?? [],
        ];
    }

    /** Annotates a row and the rows populated under it with what their relations were fetched with. */
    private static function annotate(array $wire, string $typeName, array $claims, array $context): array
    {
        $wire[self::META] = ['claims' => $claims, 'status' => $context['status'], 'locale' => $wire['locale'] ?? $context['locale'], 'cohort' => $context['cohort']];
        $relations = StrapiGraphqlTypes::TYPES[$typeName]['relations'] ?? [];
        foreach ($claims['children'] as $key => $child) {
            $target = $relations[$key] ?? null;
            if ($target === null || ! is_array($wire[$key] ?? null)) {
                continue;
            }
            $wire[$key] = $target['many']
                ? array_map(fn (mixed $row) => is_array($row) ? self::annotate($row, $target['type'], $child, $context) : $row, $wire[$key])
                : self::annotate($wire[$key], $target['type'], $child, $context);
        }

        return $wire;
    }

    // ------------------------------------------------------------------------ arguments → REST

    public static function listing(array $args, ?Type $filters): array
    {
        $params = ['pagination' => (array) ($args['pagination'] ?? [])];
        if (($args['filters'] ?? null) !== null && $filters !== null) {
            $params['filters'] = self::filters($args['filters'], $filters);
        }
        if (($args['sort'] ?? []) !== []) {
            $params['sort'] = $args['sort'];
        }

        return $params;
    }

    /** GraphQL's filters as REST's: operators and and/or/not take Strapi's $ prefix. */
    public static function filters(mixed $value, Type $type): mixed
    {
        $type = Type::getNullableType($type);
        if ($type instanceof ListOfType) {
            return is_array($value) ? array_map(fn (mixed $item) => self::filters($item, $type->getWrappedType()), $value) : $value;
        }
        if (! $type instanceof InputObjectType || ! is_array($value)) {
            return $value;
        }
        $operators = str_ends_with($type->name, 'FilterInput');
        $out = [];
        foreach ($value as $key => $item) {
            $prefixed = $operators || in_array($key, ['and', 'or', 'not'], true);
            $out[$prefixed ? '$'.$key : $key] = self::filters($item, $type->getField($key)->getType());
        }

        return $out;
    }

    /** A mutation's data as REST takes it: a zone item names its component by uid, not type. */
    private static function data(array $type, array $data): array
    {
        unset($data['publishedAt'], $data['locale']);
        foreach ($type['zones'] as $zone) {
            if (! is_array($data[$zone] ?? null)) {
                continue;
            }
            $data[$zone] = array_map(function (mixed $item) {
                if (! is_array($item)) {
                    return $item;
                }
                $typename = $item['__typename'] ?? null;
                unset($item['__typename']);

                return ['__component' => StrapiGraphqlTypes::COMPONENTS[$typename]['uid'] ?? $typename] + $item;
            }, $data[$zone]);
        }

        return $data;
    }

    /** Strapi GraphQL's pageInfo, whichever pagination the list was asked for with. */
    public static function pageInfo(array $pagination): array
    {
        if (isset($pagination['page'])) {
            return ['page' => $pagination['page'], 'pageSize' => $pagination['pageSize'], 'pageCount' => $pagination['pageCount'] ?? 0, 'total' => $pagination['total'] ?? 0];
        }
        $limit = (int) ($pagination['limit'] ?? 0);
        $total = (int) ($pagination['total'] ?? 0);

        return [
            'page' => $limit > 0 ? intdiv((int) ($pagination['start'] ?? 0), $limit) + 1 : 1,
            'pageSize' => $limit > 0 ? $limit : $total,
            'pageCount' => $limit > 0 ? (int) ceil($total / $limit) : 1,
            'total' => $total,
        ];
    }

    /** A related list's page, as Strapi's GraphQL pages a relation: ten at a time unless asked. */
    public static function page(array $items, array $pagination): array
    {
        $page = $pagination['page'] ?? null;
        $pageSize = $pagination['pageSize'] ?? null;
        $start = $pagination['start'] ?? null;
        $limit = $pagination['limit'] ?? null;
        if (($page !== null || $pageSize !== null) && ($start !== null || $limit !== null)) {
            throw new StrapiError(400, 'PaginationError', 'Cannot use both page & offset pagination in the same query');
        }
        $default = (int) config('camis.graphql.default_limit', 10);
        $max = (int) config('camis.graphql.max_limit', -1);
        if ($start !== null || $limit !== null) {
            $offset = max(0, (int) ($start ?? 0));
            $size = (int) ($limit ?? $default);
        } else {
            $size = max(1, (int) ($pageSize ?? $default));
            $offset = (max(1, (int) ($page ?? 1)) - 1) * $size;
        }
        if ($max > 0 && ($size === -1 || $size > $max)) {
            $size = $max;
        }

        return array_values(array_slice($items, $offset, $size === -1 ? null : max(1, $size)));
    }

    // ------------------------------------------------------------------------------- dispatch

    /** @return ?array a content type's REST response body */
    private static function call(array $type, string $method, array $params, Request $request, ?array $data = null, ?string $documentId = null): ?array
    {
        return self::dispatch($type['controller'], $method, $params, $request, $data === null ? null : ['data' => $data], $documentId === null ? [] : [$documentId]);
    }

    /**
     * Runs a controller's action in-process as the caller, with GraphQL's own page sizes. An API
     * token is checked against the action first ($action names it when it is not the method's
     * own, and false skips the check for an action Strapi opens to every caller).
     *
     * @param list<string> $arguments the route's parameters
     * @return mixed the JSON response's body; null for any other response
     */
    public static function dispatch(string $controller, string $method, array $params, Request $request, ?array $body = null, array $arguments = [], string|false|null $action = null): mixed
    {
        if ($action !== false) {
            self::authorize($request, $action ?? (StrapiGraphqlTypes::TOKENS ? StrapiApiTokens::actionOf($controller, $method) : null));
        }
        $inner = Request::create(
            '/api/graphql',
            self::VERBS[$method] ?? ($body === null ? 'GET' : 'POST'),
            [],
            [],
            [],
            ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => (string) $request->ip()],
            $body === null ? null : (string) json_encode($body),
        );
        $inner->query->replace(self::query($params));
        $inner->setUserResolver($request->getUserResolver());
        $inner->attributes->add($request->attributes->all());
        $saved = [config('camis.rest.default_limit'), config('camis.rest.max_limit')];
        config([
            'camis.rest.default_limit' => (int) config('camis.graphql.default_limit', 10),
            'camis.rest.max_limit' => max(0, (int) config('camis.graphql.max_limit', -1)),
        ]);
        try {
            $response = app($controller)->{$method}($inner, ...$arguments);
        } finally {
            config(['camis.rest.default_limit' => $saved[0], 'camis.rest.max_limit' => $saved[1]]);
        }

        return $response instanceof JsonResponse ? $response->getData(true) : null;
    }

    /** The caller's API token, checked against $action as StrapiApiToken checks a REST route's. */
    public static function authorize(Request $request, ?string $action): void
    {
        $token = StrapiGraphqlTypes::TOKENS ? StrapiApiTokens::current() : null;
        if ($token === null) {
            return;
        }
        if (! StrapiApiTokens::allows($token, $action)) {
            throw new AuthorizationException();
        }
        StrapiApiTokens::actFor($request, $token, $action);
    }

    /** Whether the caller is an API token rather than a role. */
    public static function token(): bool
    {
        return StrapiGraphqlTypes::TOKENS && StrapiApiTokens::current() !== null;
    }

    /** Values as a query string would carry them, which is how the REST API reads its parameters. */
    private static function query(array $params): array
    {
        $out = [];
        foreach ($params as $key => $value) {
            if ($value === null) {
                continue;
            }
            $out[$key] = match (true) {
                is_array($value) => self::query($value),
                is_bool($value) => $value ? 'true' : 'false',
                default => (string) $value,
            };
        }

        return $out;
    }

    /** The REST route key of a document: its documentId, unless its type is keyed by a field of its own. */
    private static function routeKey(array $type, string $documentId, array $params, Request $request): ?string
    {
        if ($type['routeKey'] === null) {
            return $documentId;
        }
        $lookup = array_intersect_key($params, array_flip(['status', 'locale']));
        $lookup['filters'] = ['documentId' => ['$eq' => $documentId]];
        $lookup['pagination'] = ['limit' => 1, 'withCount' => false];
        $row = self::call($type, 'index', $lookup, $request)['data'][0] ?? null;

        return isset($row[$type['routeKey']]) ? (string) $row[$type['routeKey']] : null;
    }

    /** A document the caller cannot see is null, as Strapi's GraphQL sends it. */
    public static function found(\Closure $call): ?array
    {
        try {
            return $call();
        } catch (HttpExceptionInterface $e) {
            if ($e->getStatusCode() === 404) {
                return null;
            }
            throw $e;
        } catch (StrapiError $e) {
            if ($e->status === 404) {
                return null;
            }
            throw $e;
        }
    }

    // --------------------------------------------------------------------------------- errors

    private static function refused(string $message, string $code, int $status = 400): JsonResponse
    {
        return response()->json(['errors' => [['message' => $message, 'extensions' => ['code' => $code]]]], $status);
    }

    /** @param list<Error> $errors */
    private static function executed(array $errors): bool
    {
        foreach ($errors as $error) {
            if ($error->getPath() !== null) {
                return true;
            }
        }

        return false;
    }

    private static function mutates(\GraphQL\Language\AST\DocumentNode $document, mixed $operationName): bool
    {
        foreach ($document->definitions as $definition) {
            if ($definition instanceof OperationDefinitionNode && $definition->operation === 'mutation'
                && (! is_string($operationName) || $definition->name?->value === $operationName)) {
                return true;
            }
        }

        return false;
    }

    /** Strapi's error: its code, and the application error behind it as the REST API names it. */
    private static function format(Error $error, ?string $code = null): array
    {
        $previous = $error->getPrevious();
        $message = $error->getMessage();
        $extensions = [];
        if ($code !== null) {
            $extensions['code'] = $code;
        } elseif ($previous instanceof StrapiError && $previous->status !== 403) {
            $extensions['code'] = match ($previous->name) {
                'ValidationError' => 'BAD_USER_INPUT',
                'ForbiddenError', 'UnauthorizedError' => 'FORBIDDEN',
                default => 'STRAPI_'.strtoupper((string) preg_replace('/(?<!^)[A-Z]/', '_$0', $previous->name)),
            };
            $message = $previous->getMessage();
            $extensions['error'] = ['name' => $previous->name, 'message' => $message, 'details' => $previous->details === [] ? new \stdClass() : $previous->details];
        } elseif ($previous instanceof AuthorizationException || $previous instanceof StrapiError || ($previous instanceof HttpExceptionInterface && $previous->getStatusCode() === 403)) {
            $message = 'Forbidden access';
            $extensions = ['code' => 'FORBIDDEN', 'error' => ['name' => 'ForbiddenError', 'message' => $message, 'details' => new \stdClass()]];
        } elseif ($previous instanceof Throwable) {
            report($previous);
            $message = 'Internal Server Error';
            $extensions['code'] = 'INTERNAL_SERVER_ERROR';
        } else {
            $extensions['code'] = $error->getPath() === null ? 'BAD_USER_INPUT' : 'INTERNAL_SERVER_ERROR';
        }
        $out = ['message' => $message];
        $locations = array_map(fn ($l) => $l->toSerializableArray(), $error->getLocations());
        if ($locations !== []) {
            $out['locations'] = $locations;
        }
        if ($error->getPath() !== null) {
            $out['path'] = $error->getPath();
        }
        $out['extensions'] = $extensions;

        return $out;
    }
}
`;

/** POST and GET /graphql, beside /api rather than under it, as Strapi serves it. */
export const emitGraphqlRoutes = (secured: boolean): string => `<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

use App\\GraphQL\\StrapiGraphql;
use App\\Http\\Middleware\\StrapiActiveUser;
${secured ? "use App\\Http\\Middleware\\StrapiApiToken;\n" : ""}use App\\Http\\Middleware\\StrapiCredentials;
use App\\Http\\Middleware\\StrapiErrors;
use Illuminate\\Support\\Facades\\Route;

// The content API's own credentials: an API token, else a session, else the public role.
Route::middleware([StrapiErrors::class, ${secured ? "StrapiApiToken::class, " : ""}StrapiCredentials::class.':optional', StrapiActiveUser::class])
    ->match(['get', 'post'], '/graphql', StrapiGraphql::class);
`;
