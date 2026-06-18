<?php

declare(strict_types=1);

namespace App\Support;

final class Ring1 {
    public static function ok($value): array { return ["ok" => true, "value" => $value]; }
    public static function err(string $code): array { return ["ok" => false, "error" => $code]; }

    private static function typeOf($v): string {
        if ($v === null) return "null";
        if (is_bool($v)) return "boolean";
        if (is_int($v) || is_float($v)) return "number";
        return "string";
    }
    private static function num($v): float { return (float) $v; }

    public static function lit($value): array { return self::ok($value); }
    public static function var(array $data, string $name): array {
        return array_key_exists($name, $data) ? self::ok($data[$name]) : self::err("UNKNOWN_VAR");
    }

    private static function force2(callable $a, callable $b, callable $f): array {
        $x = $a(); if (!$x["ok"]) return $x;
        $y = $b(); if (!$y["ok"]) return $y;
        return $f($x["value"], $y["value"]);
    }
    private static function eqValues($x, $y): array {
        $tx = self::typeOf($x); $ty = self::typeOf($y);
        if ($tx === "null" && $ty === "null") return self::ok(true);
        if ($tx === "null" || $ty === "null") return self::ok(false);
        if ($tx !== $ty) return self::err("TYPE_MISMATCH");
        if ($tx === "number") return self::ok(self::num($x) === self::num($y));
        if ($tx === "string") return self::ok(strcmp($x, $y) === 0);
        return self::ok($x === $y);
    }
    private static function order($x, $y, callable $f): array {
        $tx = self::typeOf($x); $ty = self::typeOf($y);
        if ($tx === "number" && $ty === "number") { $c = self::num($x) <=> self::num($y); return self::ok($f($c)); }
        if ($tx === "string" && $ty === "string") { $c = strcmp($x, $y); $c = $c < 0 ? -1 : ($c > 0 ? 1 : 0); return self::ok($f($c)); }
        return self::err("TYPE_MISMATCH");
    }
    private static function arith($x, $y, callable $f): array {
        if (self::typeOf($x) !== "number" || self::typeOf($y) !== "number") return self::err("TYPE_MISMATCH");
        return $f(self::num($x), self::num($y));
    }

    public static function eq(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::eqValues($x, $y)); }
    public static function ne(callable $a, callable $b): array { $e = self::force2($a, $b, fn($x, $y) => self::eqValues($x, $y)); return $e["ok"] ? self::ok($e["value"] === false) : $e; }
    public static function lt(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c < 0)); }
    public static function lte(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c <= 0)); }
    public static function gt(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c > 0)); }
    public static function gte(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c >= 0)); }

    public static function add(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m + $n))); }
    public static function sub(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m - $n))); }
    public static function mul(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m * $n))); }
    public static function div(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => $n === 0.0 ? self::err("DIV_BY_ZERO") : self::ok($m / $n))); }

    public static function and(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); if ($v["value"] === false) return self::ok(false); }
        return self::ok(true);
    }
    public static function or(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); if ($v["value"] === true) return self::ok(true); }
        return self::ok(false);
    }
    public static function not(callable $a): array { $v = $a(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); return self::ok(!$v["value"]); }
    public static function isNull(callable $a): array { $v = $a(); return $v["ok"] ? self::ok($v["value"] === null) : $v; }
    public static function coalesce(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if ($v["value"] !== null) return self::ok($v["value"]); }
        return self::ok(null);
    }
}
