<?php

declare(strict_types=1);

namespace App\Support;

use RuntimeException;

/** A JSON-RPC error the MCP server answers with, or a tool's own failure (code 0). */
final class StrapiMcpError extends RuntimeException
{
    public function __construct(int $code, string $message)
    {
        parent::__construct($message, $code);
    }

    public static function notFound(): self
    {
        return new self(0, 'Document not found.');
    }
}
