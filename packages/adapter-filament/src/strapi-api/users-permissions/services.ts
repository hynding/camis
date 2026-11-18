import { PHP_MARKER } from "../../hooks/names";

export const STRAPI_SERVICES_PATH = "app/Support/StrapiServices.php";

/**
 * Who may use a plugin service (the locales list, sending email, reading roles): an API token
 * holding its action, already checked by StrapiApiToken, or a caller whose role holds the service,
 * the public role's for a caller without a session. An app without roles leaves every one open.
 */
export const emitStrapiServices = (secured: boolean, guests: boolean): string => {
  const check = !secured
    ? "return true;"
    : guests
      ? "return PublicRole::allows($user, 'service.'.$service);"
      : "return $user !== null && $user->can('service.'.$service);";
  const tokens = secured
    ? `
        // A token's request was already checked against its token, which stands in for a role.
        if (StrapiApiTokens::active()) {
            return;
        }`
    : "";
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Contracts\\Auth\\Authenticatable;
use Illuminate\\Http\\Request;

final class StrapiServices
{
    /** Whether $user (null: a caller without a session) may use $service, as its role allows. */
    public static function allows(?Authenticatable $user, string $service): bool
    {
        ${check}
    }

    /** Refuses the request, as Strapi does, unless its token or its caller's role allows $service. */
    public static function authorize(Request $request, string $service): void
    {${tokens}
        if (! self::allows($request->user(), $service)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
    }
}
`;
};
