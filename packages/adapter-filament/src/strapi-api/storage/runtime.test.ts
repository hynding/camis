import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../../hooks/names";
import {
  emitStrapiComponentAttributes,
  emitStrapiComponents,
  emitStrapiDateTime,
  emitStrapiJwtGuard,
  emitStrapiRows,
} from "./runtime";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

interface RuntimeFile {
  name: string;
  namespace: string;
  emit: () => string;
}

const files: RuntimeFile[] = [
  { name: "StrapiDateTime", namespace: "App\\Casts", emit: emitStrapiDateTime },
  { name: "StrapiRows", namespace: "App\\Support", emit: emitStrapiRows },
  { name: "StrapiComponents", namespace: "App\\Support", emit: emitStrapiComponents },
  {
    name: "StrapiComponentAttributes",
    namespace: "App\\Support",
    emit: emitStrapiComponentAttributes,
  },
  { name: "StrapiJwtGuard", namespace: "App\\Http\\Middleware", emit: emitStrapiJwtGuard },
];

describe("strapi storage runtime — file shape", () => {
  it.each(files)(
    "$name opens with the marker, strict types and its namespace",
    ({ name, namespace, emit }) => {
      const php = emit();
      expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
      expect(php).toContain(`namespace ${namespace};`);
      expect(php).toContain(name);
      expect(php.endsWith("\n")).toBe(true);
    },
  );

  it.each(files)("$name is idempotent", ({ emit }) => {
    expect(emit()).toBe(emit());
  });
});

describe("emitStrapiDateTime", () => {
  it("golden", async () => {
    await expect(emitStrapiDateTime()).toMatchFileSnapshot(
      "../../__golden__/storage/StrapiDateTime.php",
    );
  });

  it("branches on the model's own connection driver, not the default connection", () => {
    const php = emitStrapiDateTime();
    expect(php).toContain("$model->getConnection()->getDriverName()");
    expect(php).toContain("$driver === 'sqlite'");
    expect(php).not.toContain("DB::connection()->getDriverName()");
  });

  it("writes SQLite milliseconds and a microsecond UTC string elsewhere", () => {
    const php = emitStrapiDateTime();
    expect(php).toContain("(int) $date->getTimestampMs()");
    expect(php).toContain("$date->utc()->format('Y-m-d H:i:s.u')");
  });

  it("reads milliseconds and datetime strings, and passes null through both ways", () => {
    const php = emitStrapiDateTime();
    expect(php).toContain("Carbon::createFromTimestampMs((int) $value)");
    expect(php).toContain("implements CastsAttributes");
    expect(php).toContain("return self::fromStorage($value);");
  });

  it("exposes the conversion as static helpers, so the component writer can reuse it", () => {
    const php = emitStrapiDateTime();
    expect(php).toContain("public static function fromStorage(mixed $value): ?Carbon");
    expect(php).toContain(
      "public static function toStorage(mixed $value, string $driver): int|string|null",
    );
    expect(php).toContain(
      "return self::toStorage($value, $model->getConnection()->getDriverName());",
    );
  });

  it("parses a stored datetime string as UTC, not in the application timezone", () => {
    const php = emitStrapiDateTime();
    expect(php).toContain("Carbon::parse($value, 'UTC')");
    expect(php).not.toContain("Carbon::parse((string) $value)");
  });
});

describe("emitStrapiRows", () => {
  it("golden", async () => {
    await expect(emitStrapiRows()).toMatchFileSnapshot("../../__golden__/storage/StrapiRows.php");
  });

  it("fills the Strapi-owned row columns before saving", () => {
    const php = emitStrapiRows();
    expect(php).toContain("use Visus\\Cuid2\\Cuid2;");
    expect(php).toContain("(string) new Cuid2(24)");
    expect(php).toContain("$m->published_at = now();");
    expect(php).toContain("$m->locale = null;");
    expect(php).toContain("$m->save();");
  });

  it("links idempotently and orders the inverse side per target id", () => {
    const php = emitStrapiRows();
    expect(php).toContain("$row = [$local => $m->getKey(), $foreign => $id];");
    expect(php).toContain("->where($foreign, $id)->max($ord)) + 1;");
    expect(php).toContain(
      "public static function unlinkAll(Model $m, string $table, string $local): void",
    );
  });
});

describe("emitStrapiComponents", () => {
  it("golden", async () => {
    await expect(emitStrapiComponents()).toMatchFileSnapshot(
      "../../__golden__/storage/StrapiComponents.php",
    );
  });

  it("exposes the four entry points the controllers and the trait call", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("public static function load(Collection $rows, array $map): void");
    expect(php).toContain("public static function loadOne(Model $m, array $map): void");
    expect(php).toContain("public static function apply(Model $m, array $map, array $wire): void");
    expect(php).toContain("public static function columnsOf(array $wire, array $map): array");
    expect(php).toContain("public static function deleteAll(Model $m, array $map): void");
  });

  it("batches the link query per level and one query per component table", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("->whereIn('entity_id', array_keys($entities))");
    expect(php).toContain("->whereIn('field', $fields)");
    expect(php).toContain("->orderBy('order')");
    expect(php).toContain("->whereIn('id', $ids)->get()->keyBy('id')");
  });

  it("materializes single components flat and repeatables as a Collection of rows", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("$target->strapiComponents[$attribute] = $value;");
    expect(php).toContain("$target->setRelation($c['relationName'], new Collection($children));");
    expect(php).toContain("$row->strapiComponentsLoaded = true;");
    expect(php).toContain("$child = new stdClass();");
  });

  it("writes the link row Strapi expects, with order for repeatables only", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("'component_type' => $c['type'],");
    expect(php).toContain("'field' => $c['field'],");
    expect(php).toContain("'order' => $order,");
    expect(php).toContain("self::link($connection, $c, $entityId, $id, $order);");
    expect(php).toContain("$id = self::insert($connection, $driver, $c, $columns, $children);");
    expect(php).toContain("self::link($connection, $c, $entityId, $id, null);");
  });

  it("deletes the old subtree before re-inserting, and never opens its own transaction", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("self::clear($connection, (int) $link->cmp_id, $child);");
    expect(php).toContain("self::clear($connection, $entityId, $c);");
    expect(php).not.toContain("DB::transaction");
  });

  it("treats an all-null single component as a removal", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("if (self::isBlank($c, $columns, $children)) {");
  });

  it("converts component scalars by their IR type on both sides of the boundary", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("use App\\Casts\\StrapiDateTime;");
    expect(php).toContain("$driver = $m->getConnection()->getDriverName();");
    expect(php).toContain("'dateTime', 'timestamp' => StrapiDateTime::fromStorage($value),");
    expect(php).toContain("'dateTime', 'timestamp' => StrapiDateTime::toStorage($value, $driver),");
    expect(php).toContain("json_decode($value, true)");
    expect(php).toContain("json_encode($value)");
    expect(php).toContain("'boolean' => (bool) $value,");
    expect(php).toContain("self::fromStorage($row->{$s['column']} ?? null, $s['type'])");
    expect(php).toContain(
      "self::toStorage($columns[$s['flatAttribute']] ?? null, $s['type'], $driver)",
    );
  });

  // Spec 17i: `date`/`time` are strings end to end on this layout — the owner model leaves them
  // uncast and the serializer passes them through, so converting a component's copy to a Carbon
  // here would make the same IR type render two different ways depending on where it sits.
  it("leaves a date component scalar as the string Strapi stored, in both directions", () => {
    const php = emitStrapiComponents();
    expect(php).not.toContain("'date' => StrapiDateTime::fromStorage($value),");
    expect(php).not.toContain("'date' =>");
  });

  it("reads the level's link table without assuming the map is a 0-indexed list", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("reset($map)['cmpsTable']");
    expect(php).not.toContain("$map[0]");
  });

  it("skips the clear under a component row it just inserted", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("bool $fresh");
    expect(php).toContain("if (! $fresh) {");
    expect(php).toContain(
      "self::write($connection, $driver, $id, $child, $columns, $children, true);",
    );
  });

  it("refuses to write components for a model that has no key yet", () => {
    const php = emitStrapiComponents();
    expect(php).toContain("use LogicException;");
    expect(php).toContain(
      "throw new LogicException('StrapiComponents::apply requires a saved model');",
    );
  });

  it("strips component attributes — and only those — from the owner's columns", () => {
    const php = emitStrapiComponents();
    expect(php).toContain(
      "return array_diff_key($columns, array_flip(self::flatAttributes($map)));",
    );
  });
});

describe("emitStrapiComponentAttributes", () => {
  it("golden", async () => {
    await expect(emitStrapiComponentAttributes()).toMatchFileSnapshot(
      "../../__golden__/storage/StrapiComponentAttributes.php",
    );
  });

  it("caches on the model and reads the three generated constants", () => {
    const php = emitStrapiComponentAttributes();
    expect(php).toContain("trait StrapiComponentAttributes");
    expect(php).toContain("public array $strapiComponents = [];");
    expect(php).toContain("public bool $strapiComponentsLoaded = false;");
    expect(php).toContain("array_key_exists($key, $this->strapiComponents)");
    expect(php).toContain("static::COMPONENT_ATTRIBUTES");
    expect(php).toContain("static::COMPONENT_RELATIONS");
    expect(php).toContain("StrapiComponents::loadOne($this, static::COMPONENT_MAP);");
  });

  it("defers unknown keys to Eloquent on both the attribute and the relation path", () => {
    const php = emitStrapiComponentAttributes();
    expect(php).toContain("return parent::getAttribute($key);");
    expect(php).toContain("return parent::getRelationValue($key);");
  });
});

describe("emitStrapiJwtGuard", () => {
  it("golden", async () => {
    await expect(emitStrapiJwtGuard()).toMatchFileSnapshot(
      "../../__golden__/storage/StrapiJwtGuard.php",
    );
  });

  it("decodes Strapi's HS256 token with the configured secret", () => {
    const php = emitStrapiJwtGuard();
    expect(php).toContain("$request->bearerToken()");
    expect(php).toContain("config('camis.jwt_secret')");
    expect(php).toContain("JWT::decode($token, new Key($secret, 'HS256'))");
    expect(php).toContain("$request->setUserResolver(fn () => $user);");
  });

  it("401s via AuthenticationException on every failure, including an empty secret", () => {
    const php = emitStrapiJwtGuard();
    expect(php).toContain("throw new AuthenticationException();");
    expect(php).toContain("$token === null || $token === '' || $secret === ''");
    expect(php).toContain("ExpiredException");
    expect(php).toContain("SignatureInvalidException");
    expect(php).toContain("UnexpectedValueException");
    expect(php).toContain("DomainException");
    expect(php).toContain("(bool) $user->blocked");
    expect(php).not.toContain("class UnauthorizedError");
  });
});

describe("php -l", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "storage-runtime-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp()).each(files)("$name lints clean", ({ name, emit }) => {
    const file = join(dir, `${name}.php`);
    writeFileSync(file, emit());
    const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
    expect(out).toContain("No syntax errors detected");
  });
});
