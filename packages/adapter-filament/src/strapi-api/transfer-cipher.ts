import { PHP_MARKER } from "../hooks/names";

export const TRANSFER_CIPHER_PATH = "app/Support/StrapiTransferCipher.php";

/**
 * Strapi's archive encryption (`@strapi/data-transfer` utils/encryption): AES-128-ECB with
 * PKCS#7 padding, keyed by scrypt(key, salt '', 16 bytes, N=16384, r=8, p=1) as Node's
 * `scryptSync` derives it. PHP has no scrypt of its own (sodium's takes other parameters), so it
 * is written out here, as strapi-php's `Scrypt` does.
 */
/** Salsa20's double round, columns then rows: each quarter-round step as [target, a, b, shift]. */
const DOUBLE_ROUND = [
  [4, 0, 12, 7],
  [8, 4, 0, 9],
  [12, 8, 4, 13],
  [0, 12, 8, 18],
  [9, 5, 1, 7],
  [13, 9, 5, 9],
  [1, 13, 9, 13],
  [5, 1, 13, 18],
  [14, 10, 6, 7],
  [2, 14, 10, 9],
  [6, 2, 14, 13],
  [10, 6, 2, 18],
  [3, 15, 11, 7],
  [7, 3, 15, 9],
  [11, 7, 3, 13],
  [15, 11, 7, 18],
  [1, 0, 3, 7],
  [2, 1, 0, 9],
  [3, 2, 1, 13],
  [0, 3, 2, 18],
  [6, 5, 4, 7],
  [7, 6, 5, 9],
  [4, 7, 6, 13],
  [5, 4, 7, 18],
  [11, 10, 9, 7],
  [8, 11, 10, 9],
  [9, 8, 11, 13],
  [10, 9, 8, 18],
  [12, 15, 14, 7],
  [13, 12, 15, 9],
  [14, 13, 12, 13],
  [15, 14, 13, 18],
] as const;

// Written out step by step: scrypt runs the core half a million times, so a loop over this table
// (or a closure per rotation) would make PHP several times slower.
const doubleRound = (): string =>
  DOUBLE_ROUND.map(
    ([t, a, b, c]) =>
      `            $t = ($x[${a}] + $x[${b}]) & 0xffffffff;\n            $x[${t}] ^= (($t << ${c}) & 0xffffffff) | ($t >> ${32 - c});`,
  ).join("\n");

export const emitStrapiTransferCipher = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n` +
  String.raw`
final class StrapiTransferCipher
{
    public static function decrypt(string $bytes, string $key): string
    {
        $plain = openssl_decrypt($bytes, 'aes-128-ecb', self::scrypt($key, '', 16), OPENSSL_RAW_DATA);
        if ($plain === false) {
            throw new \RuntimeException('The archive cannot be decrypted with this key');
        }

        return $plain;
    }

    /** RFC 7914 scrypt. */
    public static function scrypt(string $password, string $salt, int $length, int $n = 16384, int $r = 8, int $p = 1): string
    {
        $blockSize = 128 * $r;
        $b = hash_pbkdf2('sha256', $password, $salt, 1, $p * $blockSize, true);
        $out = '';
        for ($i = 0; $i < $p; $i++) {
            $out .= self::roMix(substr($b, $i * $blockSize, $blockSize), $n, $r);
        }

        return hash_pbkdf2('sha256', $password, $out, 1, $length, true);
    }

    private static function roMix(string $block, int $n, int $r): string
    {
        $x = array_values(unpack('V*', $block) ?: []);
        $v = [];
        for ($i = 0; $i < $n; $i++) {
            // Packed: N blocks of 128·r bytes, not N PHP arrays.
            $v[$i] = pack('V*', ...$x);
            $x = self::blockMix($x, $r);
        }
        $words = 32 * $r;
        $last = $words - 16;
        for ($i = 0; $i < $n; $i++) {
            $vj = array_values(unpack('V*', $v[$x[$last] & ($n - 1)]) ?: []);
            for ($k = 0; $k < $words; $k++) {
                $x[$k] ^= $vj[$k];
            }
            $x = self::blockMix($x, $r);
        }

        return pack('V*', ...$x);
    }

    /**
     * @param list<int> $b the words of 2r 64-byte blocks
     * @return list<int>
     */
    private static function blockMix(array $b, int $r): array
    {
        $x = array_slice($b, (2 * $r - 1) * 16, 16);
        $even = [];
        $odd = [];
        for ($i = 0; $i < 2 * $r; $i++) {
            for ($k = 0; $k < 16; $k++) {
                $x[$k] ^= $b[$i * 16 + $k];
            }
            $x = self::salsa208($x);
            if ($i % 2 === 0) {
                array_push($even, ...$x);
            } else {
                array_push($odd, ...$x);
            }
        }

        return [...$even, ...$odd];
    }

    /**
     * The Salsa20/8 core over 16 little-endian words.
     *
     * @param list<int> $in
     * @return list<int>
     */
    private static function salsa208(array $in): array
    {
        $x = $in;
        for ($i = 0; $i < 4; $i++) {
` +
  doubleRound() +
  String.raw`
        }
        for ($k = 0; $k < 16; $k++) {
            $x[$k] = ($x[$k] + $in[$k]) & 0xffffffff;
        }

        return $x;
    }
}
`;
