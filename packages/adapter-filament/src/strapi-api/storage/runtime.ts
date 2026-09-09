import { PHP_MARKER } from "../../hooks/names";

export { emitStrapiComponents } from "./runtime-components";

/**
 * `App\Casts\StrapiDateTime` — the cast every Strapi datetime column carries.
 *
 * Strapi's physical representation is per driver: SQLite holds integer milliseconds since the
 * epoch, MySQL a `datetime(6)` and Postgres a `timestamp(6)`. Laravel's own `datetime` cast
 * assumes the string form everywhere, so on SQLite it would read `1757280000000` as a year.
 */
export const emitStrapiDateTime = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Casts;

use DateTimeInterface;
use Illuminate\\Contracts\\Database\\Eloquent\\CastsAttributes;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Support\\Carbon;

/**
 * Reads and writes the datetime columns Strapi created, whose storage differs per driver: SQLite
 * holds integer milliseconds since the epoch, MySQL a \`datetime(6)\` string and Postgres a
 * \`timestamp(6)\`. Laravel's built-in \`datetime\` cast assumes the string form on every driver, so
 * under SQLite it would parse Strapi's millisecond integer as a year.
 *
 * The driver comes from the model's own connection rather than the default one, so a model bound
 * to a second connection still writes that connection's format.
 */
class StrapiDateTime implements CastsAttributes
{
    public function get(Model $model, string $key, mixed $value, array $attributes): ?Carbon
    {
        return $value === null ? null : self::toCarbon($value);
    }

    public function set(Model $model, string $key, mixed $value, array $attributes): int|string|null
    {
        if ($value === null) {
            return null;
        }

        $date = self::toCarbon($value);

        return $model->getConnection()->getDriverName() === 'sqlite'
            ? (int) $date->getTimestampMs()
            : $date->utc()->format('Y-m-d H:i:s.u');
    }

    /** Both forms reach this cast: milliseconds (from SQLite) and a datetime string (elsewhere). */
    private static function toCarbon(mixed $value): Carbon
    {
        if ($value instanceof DateTimeInterface) {
            return Carbon::instance($value);
        }

        if (is_int($value) || is_float($value) || (is_string($value) && is_numeric($value))) {
            return Carbon::createFromTimestampMs((int) $value);
        }

        return Carbon::parse((string) $value);
    }
}
`;

/**
 * `App\Support\StrapiRows` — the row bookkeeping Strapi does that a Laravel app writing the same
 * tables has to do by hand: the Strapi-owned columns on create, and the `_lnk` rows for relations.
 */
export const emitStrapiRows = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Query\\Builder;
use Illuminate\\Support\\Facades\\DB;

/**
 * The row bookkeeping Strapi does for every content row and every relation, done by hand because
 * this app writes Strapi's tables directly instead of going through Strapi.
 */
final class StrapiRows
{
    /**
     * Fills the Strapi-owned columns a new content row must carry, then saves it.
     *
     * \`published_at\` is always set: in Strapi 5 a draft is a *separate row*, and this app only
     * ever writes published ones, so a null here would hide the row from Strapi's own API.
     * \`locale\` is written as an explicit NULL because it is part of Strapi's i18n key and an
     * absent column is not the same as a null one on every driver. A value the caller already set
     * wins, so an importer can carry a document id across from another instance.
     */
    public static function create(Model $m): void
    {
        $attributes = $m->getAttributes();

        if (! array_key_exists('document_id', $attributes) || $attributes['document_id'] === null) {
            $m->document_id = (string) new \\Visus\\Cuid2\\Cuid2(24);
        }

        if (! array_key_exists('published_at', $attributes) || $attributes['published_at'] === null) {
            $m->published_at = now();
        }

        if (! array_key_exists('locale', $attributes)) {
            $m->locale = null;
        }

        $m->save();
    }

    /**
     * Points this model's \`_lnk\` row at $id, replacing whatever it was linked to before.
     *
     * The delete first is what makes re-linking idempotent for the single-owner (manyToOne)
     * relations this helper serves. \`$ord\` is Strapi's position of this model within the *inverse*
     * side's list, so the next position is counted per target id, not per owner.
     */
    public static function link(
        Model $m,
        string $table,
        string $local,
        string $foreign,
        int $id,
        ?string $ord = null
    ): void {
        self::table($m, $table)->where($local, $m->getKey())->delete();

        $row = [$local => $m->getKey(), $foreign => $id];

        if ($ord !== null) {
            $row[$ord] = ((int) self::table($m, $table)->where($foreign, $id)->max($ord)) + 1;
        }

        self::table($m, $table)->insert($row);
    }

    public static function unlinkAll(Model $m, string $table, string $local): void
    {
        self::table($m, $table)->where($local, $m->getKey())->delete();
    }

    /** Raw builder on the model's own connection, so a model on a second connection still works. */
    private static function table(Model $m, string $table): Builder
    {
        return DB::connection($m->getConnectionName())->table($table);
    }
}
`;

/**
 * `App\Support\StrapiComponentAttributes` — the model trait that makes component storage look
 * like ordinary attributes and relations to everything downstream.
 */
export const emitStrapiComponentAttributes = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Support\\Collection;

/**
 * Exposes Strapi's component storage as ordinary model attributes and relations.
 *
 * The generated model declares the three constants this trait reads: COMPONENT_ATTRIBUTES (the
 * flattened attribute names of every single component's scalars), COMPONENT_RELATIONS (the
 * relation name of every repeatable component) and COMPONENT_MAP (the map StrapiComponents
 * walks). None of those keys is a column on the owner table, so nothing in Eloquent's own
 * attribute pipeline would ever resolve them.
 *
 * Reads are lazy and per model, but a controller that already called StrapiComponents::load() for
 * a whole page pays nothing here: the loaded flag short-circuits both paths, and the values it
 * wrote are served straight from $strapiComponents.
 *
 * getAttribute() and getRelationValue() deliberately keep Eloquent's untyped signatures — adding
 * types here would break compatibility with Model's declarations.
 */
trait StrapiComponentAttributes
{
    /** Flattened component values by attribute name; only meaningful once loaded. */
    public array $strapiComponents = [];

    public bool $strapiComponentsLoaded = false;

    public function getAttribute($key)
    {
        if (! is_string($key) || $key === '') {
            return parent::getAttribute($key);
        }

        if (array_key_exists($key, $this->strapiComponents)) {
            return $this->strapiComponents[$key];
        }

        if (! $this->strapiComponentsLoaded && in_array($key, static::COMPONENT_ATTRIBUTES, true)) {
            StrapiComponents::loadOne($this, static::COMPONENT_MAP);

            return $this->strapiComponents[$key] ?? null;
        }

        return parent::getAttribute($key);
    }

    public function getRelationValue($key)
    {
        if (! is_string($key) || ! in_array($key, static::COMPONENT_RELATIONS, true)) {
            return parent::getRelationValue($key);
        }

        if (! $this->strapiComponentsLoaded) {
            StrapiComponents::loadOne($this, static::COMPONENT_MAP);
        }

        // A repeatable component with no rows still answers with an empty Collection: callers map
        // over it unconditionally, and there is no relationship method here to fall back on.
        return $this->relationLoaded($key) ? $this->getRelation($key) : new Collection();
    }
}
`;

/**
 * `App\Http\Middleware\StrapiJwtGuard` — authenticates with the JWT Strapi's users-permissions
 * plugin issues, so a token minted by either app is accepted by both.
 */
export const emitStrapiJwtGuard = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use App\\Models\\User;
use Closure;
use DomainException;
use Firebase\\JWT\\ExpiredException;
use Firebase\\JWT\\JWT;
use Firebase\\JWT\\Key;
use Firebase\\JWT\\SignatureInvalidException;
use Illuminate\\Auth\\AuthenticationException;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Auth;
use Symfony\\Component\\HttpFoundation\\Response;
use UnexpectedValueException;

/**
 * Authenticates a request with the JWT Strapi's users-permissions plugin issues: HS256 over
 * \`{ id, iat, exp }\`, signed with the same JWT_SECRET the Strapi instance uses, so a token minted
 * by either app is accepted by both.
 *
 * Every failure — no header, a token that will not decode, an unknown user, a blocked one — raises
 * AuthenticationException, which StrapiErrors renders as the 401 \`UnauthorizedError\` envelope.
 * One exception for all of them is the point: the response never says which check failed, exactly
 * as Strapi's own does not.
 */
class StrapiJwtGuard
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $this->authenticate($request);

        $request->setUserResolver(fn () => $user);
        // Policies resolve the user through the auth guard rather than the request, so
        // $this->authorize() in a controller needs this second half.
        Auth::setUser($user);

        return $next($request);
    }

    private function authenticate(Request $request): User
    {
        $token = $request->bearerToken();
        $secret = (string) config('camis.jwt_secret');

        // Refuse an unconfigured secret rather than decode with it: an empty key would let every
        // signature verify against ''.
        if ($token === null || $token === '' || $secret === '') {
            throw new AuthenticationException();
        }

        try {
            $payload = JWT::decode($token, new Key($secret, 'HS256'));
        } catch (ExpiredException|SignatureInvalidException|UnexpectedValueException|DomainException) {
            // php-jwt reports an expired token, a bad signature, a malformed token and an
            // unexpected algorithm as subclasses of these two; none of that detail may escape.
            throw new AuthenticationException();
        }

        $id = is_object($payload) && isset($payload->id) ? $payload->id : null;
        $user = is_int($id) || (is_string($id) && ctype_digit($id)) ? User::find((int) $id) : null;

        if (! $user instanceof User || (bool) $user->blocked) {
            throw new AuthenticationException();
        }

        return $user;
    }
}
`;
