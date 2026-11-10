<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\UploadedFile;
use Symfony\Component\Mime\MimeTypes;

final class StrapiMimeTypes
{
    /** What content sniffing names that a file signature does not settle. */
    private const UNDETECTED = ['application/octet-stream', 'application/json', 'application/x-empty', 'inode/x-empty'];

    /** Why the upload security refuses the upload, as Strapi words it, or null to let it through. */
    public static function rejection(UploadedFile $upload): ?string
    {
        $allowed = config('camis.upload.allowed_types');
        $denied = config('camis.upload.denied_types') ?? [];
        if ($allowed === null && $denied === []) {
            return null;
        }
        $declared = (string) $upload->getClientMimeType();
        $generic = $declared === '' || $declared === 'application/octet-stream';
        $extension = strtolower(pathinfo($upload->getClientOriginalName(), PATHINFO_EXTENSION));
        $fromExtension = $extension === '' ? null : (MimeTypes::getDefault()->getMimeTypes($extension)[0] ?? null);

        if (! $generic && self::matches($declared, $denied)) {
            return self::notAllowed($declared);
        }
        if ($fromExtension !== null && self::matches($fromExtension, $denied)) {
            return self::notAllowed($fromExtension);
        }
        $detected = self::detect($upload);
        $declaredMatchesExtension = ! $generic && $fromExtension !== null
            && (self::matches($declared, [$fromExtension]) || self::matches($fromExtension, [$declared]));
        if ($declaredMatchesExtension && $detected !== null && self::matches($detected, [$declared])) {
            return self::listed($declared, $allowed, $denied);
        }
        if ($detected !== null && self::matches($detected, $denied)) {
            return self::notAllowed($detected);
        }
        // Signatures name an Office file application/zip and an SVG application/xml: the extension decides.
        $extensionVouches = $fromExtension !== null && $allowed !== null && self::matches($fromExtension, $allowed)
            && (($detected === 'application/zip' && $fromExtension !== 'application/zip')
                || ($detected === 'application/xml' && $fromExtension === 'image/svg+xml'));
        if ($detected !== null && $allowed !== null && $allowed !== [] && ! self::matches($detected, $allowed) && ! $extensionVouches) {
            return 'MIME type is not allowed';
        }
        if ($detected !== null && ($fromExtension === null || $generic || self::matches($detected, [$fromExtension]))) {
            if ($detected === 'application/zip' && $fromExtension !== null && $fromExtension !== 'application/zip' && self::listed($fromExtension, $allowed, $denied) === null) {
                return null;
            }

            return self::listed($detected, $allowed, $denied);
        }
        if ($fromExtension !== null) {
            return self::listed($fromExtension, $allowed, $denied);
        }
        if ($declared !== '') {
            return self::listed($declared, $allowed, $denied);
        }

        return 'Cannot verify file type for security reasons';
    }

    /** The type the file's content shows, or null when its signature names none (any text). */
    private static function detect(UploadedFile $upload): ?string
    {
        $sniffed = $upload->getRealPath() === false ? null : $upload->getMimeType();
        if ($sniffed === null || $sniffed === '' || str_starts_with($sniffed, 'text/') || in_array($sniffed, self::UNDETECTED, true)) {
            return null;
        }

        return $sniffed;
    }

    /**
     * @param  list<string>|null  $allowed
     * @param  list<string>  $denied
     */
    private static function listed(string $type, ?array $allowed, array $denied): ?string
    {
        if (self::matches($type, $denied)) {
            return self::notAllowed($type);
        }
        if ($allowed === null) {
            return null;
        }
        if ($allowed === []) {
            return 'MIME type is not allowed';
        }

        return self::matches($type, $allowed) ? null : self::notAllowed($type);
    }

    /** @param  list<string>  $patterns  types, or patterns in which * stands for anything */
    private static function matches(string $type, array $patterns): bool
    {
        $type = strtolower($type);
        foreach ($patterns as $pattern) {
            $pattern = strtolower($pattern);
            if (str_contains($pattern, '*')
                ? preg_match('/^'.str_replace('\\*', '.*', preg_quote($pattern, '/')).'$/', $type) === 1
                : $pattern === $type) {
                return true;
            }
        }

        return false;
    }

    private static function notAllowed(string $type): string
    {
        return "File type '{$type}' is not allowed";
    }
}
