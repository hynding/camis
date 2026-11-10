<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Support\StrapiTransferArchives;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/** An export the Data transfer page wrote, through the signed link it made; removed once sent. */
final class StrapiTransferDownload
{
    public function __invoke(string $file): BinaryFileResponse
    {
        $path = StrapiTransferArchives::path($file);
        abort_unless(is_file($path), 404);

        return response()->download($path)->deleteFileAfterSend();
    }
}
