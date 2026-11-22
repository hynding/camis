<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Support\StrapiError;
use App\Support\StrapiRateLimits;
use App\Support\StrapiSessions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** users-permissions' session routes, which Strapi serves in refresh mode only. */
final class SessionController extends Controller
{
    public function refresh(Request $request): JsonResponse
    {
        self::refreshOnly();
        // Only a refresh that rotates nothing takes a turn, so a foreign page firing refreshes from
        // its victim's browser fills a bucket that never refuses the victim's own valid token.
        try {
            StrapiSessions::refuseForeignCookie($request);
            $token = StrapiSessions::presented($request)
                ?? throw new StrapiError(400, 'BadRequestError', 'Missing refresh token');
            $tokens = StrapiSessions::rotate($token)
                ?? throw new StrapiError(401, 'UnauthorizedError', 'Invalid refresh token');
        } catch (StrapiError $failure) {
            StrapiRateLimits::refuseFailure($request, 'refresh');

            throw $failure;
        }

        return StrapiSessions::respond($request, $tokens);
    }

    /** The request's own session (its access token's), a device's, or all. */
    public function logout(Request $request): JsonResponse
    {
        self::refreshOnly();
        $user = self::user($request);
        $deviceId = $request->json('deviceId');
        $cookieSession = StrapiSessions::sessionOf(StrapiSessions::presented($request));
        if ($request->json('scope') === 'all') {
            StrapiSessions::invalidate($user);
        } elseif (is_string($deviceId) && $deviceId !== '') {
            StrapiSessions::invalidate($user, $deviceId);
        } else {
            // The access token names the caller's own session; the cookie may be another tab's. A
            // token naming none (one issued before refresh mode), or a session already swept, ends
            // itself alone.
            $session = StrapiSessions::current($request);
            if ($session === null || ! StrapiSessions::revoke($user, $session)) {
                StrapiSessions::dropAccessToken($request);
            }
        }
        $response = response()->json(['ok' => true]);

        return StrapiSessions::cookieMode($request) && StrapiSessions::cookieEnded($cookieSession)
            ? $response->withCookie(StrapiSessions::forget())
            : $response;
    }

    public function sessions(Request $request): JsonResponse
    {
        self::refreshOnly();

        return response()->json(['data' => StrapiSessions::list(self::user($request), StrapiSessions::current($request))]);
    }

    public function revoke(Request $request, string $sessionId): JsonResponse
    {
        self::refreshOnly();
        if (! StrapiSessions::revoke(self::user($request), $sessionId)) {
            throw new StrapiError(404, 'NotFoundError', 'Session not found');
        }

        return response()->json(['data' => new \stdClass()]);
    }

    private static function refreshOnly(): void
    {
        if (! StrapiSessions::refreshMode()) {
            throw new StrapiError(404, 'NotFoundError', 'Not Found');
        }
    }

    /** An API token's request has no account, so no sessions of its own. */
    private static function user(Request $request): User
    {
        return $request->user() ?? throw new StrapiError(401, 'UnauthorizedError', 'Missing authentication');
    }
}
