<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Support\StrapiError;
use App\Support\StrapiExport;
use App\Support\StrapiTransferArchives;
use App\Support\StrapiTransferTokens;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * `strapi transfer --from` over plain HTTP, for strapi-plugin-camis: a pull token is handed this
 * app's data as the gzipped, unencrypted archive `strapi export --no-encrypt` writes (TLS guards
 * it on the way), with ?only= and ?exclude= as `strapi export` takes them.
 */
final class StrapiTransferPull
{
    public function export(Request $request): BinaryFileResponse
    {
        StrapiTransferTokens::demand($request, 'pull');
        try {
            $stages = StrapiExport::stages(self::list($request->query('only')), self::list($request->query('exclude')));
        } catch (\InvalidArgumentException $error) {
            throw StrapiError::validation($error->getMessage());
        }
        StrapiTransferArchives::unlimited();
        // Apart from the Data transfer page's archives, which it would otherwise list while this one is sent.
        $directory = storage_path('app/private/strapi-transfer-pulls');
        if (! is_dir($directory)) {
            mkdir($directory, 0775, true);
        }
        $file = $directory.DIRECTORY_SEPARATOR.bin2hex(random_bytes(16));
        $written = StrapiExport::write($file, $stages, true, null);

        return response()->download($written['path'], 'camis-export.tar.gz', [
            'Content-Type' => 'application/gzip',
            'X-Camis-Counts' => (string) json_encode((object) $written['counts']),
        ])->deleteFileAfterSend();
    }

    /** @return list<string>|null */
    private static function list(mixed $value): ?array
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (! is_string($value)) {
            throw StrapiError::validation('only and exclude are comma-separated data types');
        }

        return array_map('trim', explode(',', $value));
    }
}
