<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\StrapiAdminTokens;
use App\Support\StrapiMcpServer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Strapi's MCP endpoint (POST /mcp), stateless streamable HTTP: an admin token signs the client
 * in, each JSON-RPC message gets its answer as a server-sent event, and a request holding only
 * notifications is accepted with nothing to say. Off unless CAMIS_MCP_ENABLED is set, as Strapi's
 * server.mcp.enabled is.
 */
final class StrapiMcpController
{
    public function notAllowed(): JsonResponse
    {
        if (! config('camis.mcp.enabled')) {
            return self::notFound();
        }

        return self::rpcError(405, -32601, 'Method not allowed')->header('Allow', 'POST');
    }

    public function handle(Request $request): Response|JsonResponse
    {
        if (! config('camis.mcp.enabled')) {
            return self::notFound();
        }
        $json = str_contains((string) $request->header('Content-Type'), 'application/json');
        $messages = $json ? json_decode($request->getContent(), true) : null;
        if ($json && json_last_error() !== JSON_ERROR_NONE) {
            return response()->json(['data' => null, 'error' => ['status' => 400, 'name' => 'BadRequestError', 'message' => 'Unexpected token in JSON: Syntax error', 'details' => new \stdClass()]], 400);
        }
        $signedIn = StrapiAdminTokens::authenticate((string) $request->bearerToken());
        if ($request->bearerToken() === null || $signedIn === null) {
            return self::rpcError(401, -32000, 'Authentication required');
        }
        $accept = (string) $request->header('Accept');
        if (! str_contains($accept, 'application/json') || ! str_contains($accept, 'text/event-stream')) {
            return self::rpcError(406, -32000, 'Not Acceptable: Client must accept both application/json and text/event-stream');
        }
        if (! $json) {
            return self::rpcError(415, -32000, 'Unsupported Media Type: Content-Type must be application/json');
        }
        if (! is_array($messages)) {
            return self::rpcError(400, -32700, 'Parse error: Invalid JSON-RPC message');
        }

        $server = new StrapiMcpServer(...$signedIn);
        $answers = [];
        foreach (array_is_list($messages) ? $messages : [$messages] as $message) {
            $answer = is_array($message) ? $server->handle($message) : null;
            if ($answer !== null) {
                $answers[] = $answer;
            }
        }
        if ($answers === []) {
            return response('', 202);
        }
        $stream = '';
        foreach ($answers as $answer) {
            $stream .= "event: message\ndata: ".json_encode($answer, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)."\n\n";
        }

        return response($stream, 200, ['Content-Type' => 'text/event-stream', 'Cache-Control' => 'no-cache, no-transform', 'X-Accel-Buffering' => 'no']);
    }

    private static function rpcError(int $status, int $code, string $message): JsonResponse
    {
        return response()->json(['jsonrpc' => '2.0', 'error' => ['code' => $code, 'message' => $message], 'id' => null], $status);
    }

    private static function notFound(): JsonResponse
    {
        return response()->json(['data' => null, 'error' => ['status' => 404, 'name' => 'NotFoundError', 'message' => 'Not Found', 'details' => new \stdClass()]], 404);
    }
}
