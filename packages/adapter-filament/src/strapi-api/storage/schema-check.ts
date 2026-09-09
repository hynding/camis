import type { ContentType, IrDocument } from "@camis/ir-schema";
import { emitField } from "../../fields";
import { PHP_MARKER } from "../../hooks/names";
import { phpSingleQuoted } from "../../php-literal";
import { componentMap, type MappedComponent } from "./component-map";
import { ownerLinks, strapiTable } from "./names";

/**
 * The columns Strapi 5 puts on every content row regardless of the IR. `id` is the physical
 * primary key the link and `_cmps` tables point at; `document_id`, `published_at` and `locale`
 * are the draft/publish and i18n bookkeeping the generated models fill; the two timestamps carry
 * the per-driver `StrapiDateTime` cast.
 */
const STRAPI_ROW_COLUMNS = [
  "id",
  "document_id",
  "created_at",
  "updated_at",
  "published_at",
  "locale",
];

/** Strapi's generic component-link table: identical on a content table and on a component table. */
const CMPS_COLUMNS = ["id", "entity_id", "cmp_id", "component_type", "field", "order"];

/**
 * `up_users` as `App\Models\User`, the Strapi-storage `AuthController` and `StrapiJwtGuard`
 * actually use it — not every column the users-permissions plugin creates. `reset_password_token`
 * and friends are Strapi's business; a missing one cannot break the generated app.
 */
const UP_USERS_COLUMNS = [
  "id",
  "document_id",
  "username",
  "email",
  "provider",
  "password",
  "confirmed",
  "blocked",
  "created_at",
  "updated_at",
  "published_at",
  "locale",
];

/** `type` is the only authorization datum the policies read; `name` is the seeded role label. */
const UP_ROLES_COLUMNS = ["id", "type", "name"];

/** The link table `AuthController` writes on register and `User::roles()` reads on every request. */
const UP_USERS_ROLE_LNK_COLUMNS = ["user_id", "role_id", "user_ord"];

/**
 * Adds a table's columns, unioning with any already recorded for it (a component shared by two
 * content types is walked once per owner) and preserving first-seen order so the emitted map is
 * deterministic.
 */
const record = (into: Map<string, string[]>, table: string, columns: string[]): void => {
  const existing = into.get(table);
  if (existing === undefined) {
    into.set(table, [...columns]);
    return;
  }
  for (const c of columns) if (!existing.includes(c)) existing.push(c);
};

const recordComponents = (into: Map<string, string[]>, nodes: MappedComponent[]): void => {
  for (const c of nodes) {
    record(into, c.cmpsTable, CMPS_COLUMNS);
    record(into, c.table, ["id", ...c.scalars.map((s) => s.column)]);
    recordComponents(into, c.nested);
  }
};

/**
 * Every table and column the generated Strapi-storage code reads or writes — the contract this
 * app needs Strapi's own migrations to have produced. Deliberately *not* a mirror of Strapi's
 * schema: a column nothing generated touches is not this app's business, and reporting it missing
 * would turn a harmless Strapi version difference into a failed deploy check.
 *
 * Table keys are sorted; each column list keeps a stable, meaning-ordered shape (the Strapi-owned
 * row columns before the IR's own, in IR field order).
 */
export const expectedSchema = (
  doc: IrDocument,
  emitted: ContentType[],
): Record<string, string[]> => {
  const tables = new Map<string, string[]>();

  for (const ct of emitted) {
    const columns = ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component" && f.type !== "dynamicZone")
      .map((f) => emitField(f).column);
    record(tables, strapiTable(ct), [...STRAPI_ROW_COLUMNS, ...columns]);

    for (const link of ownerLinks(ct)) {
      record(tables, link.table, [
        link.local,
        link.foreign,
        ...(link.ord !== undefined ? [link.ord] : []),
      ]);
    }

    // `recordComponents` records each node's own `cmpsTable`, which for a root component is
    // exactly this table — so a content type with no component fields gets no `_cmps` entry.
    recordComponents(tables, componentMap(doc, ct));
  }

  record(tables, "up_users", UP_USERS_COLUMNS);
  record(tables, "up_roles", UP_ROLES_COLUMNS);
  record(tables, "up_users_role_lnk", UP_USERS_ROLE_LNK_COLUMNS);

  const out: Record<string, string[]> = {};
  for (const table of [...tables.keys()].sort()) out[table] = tables.get(table)!;
  return out;
};

const sp = (n: number): string => " ".repeat(n);

const expectedLiteral = (expected: Record<string, string[]>): string => {
  const entries = Object.entries(expected).map(([table, columns]) => {
    const cols = columns.map((c) => `${sp(12)}${phpSingleQuoted(c)},`).join("\n");
    return `${sp(8)}${phpSingleQuoted(table)} => [\n${cols}\n${sp(8)}],`;
  });
  return entries.length === 0 ? "[]" : `[\n${entries.join("\n")}\n${sp(4)}]`;
};

/**
 * `php artisan camis:strapi-schema-check` — the deploy-time assertion that the Strapi database
 * this app is pointed at actually carries the tables and columns the generated code reads and
 * writes. camis emits no migrations on this layout (Strapi owns the schema), so this command is
 * the only thing standing between a schema drift and a runtime 500.
 *
 * Laravel 12 auto-discovers commands in `app/Console/Commands`, so nothing needs registering.
 */
export const emitSchemaCheck = (expected: Record<string, string[]>): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Console\\Commands;

use Illuminate\\Console\\Command;
use Illuminate\\Support\\Facades\\Schema;

class CamisStrapiSchemaCheck extends Command
{
    protected $signature = 'camis:strapi-schema-check';

    protected $description = 'Verify the Strapi-owned database carries every table and column this app reads or writes.';

    /** Table => the columns the generated code touches. Strapi owns everything else. */
    private const EXPECTED = ${expectedLiteral(expected)};

    public function handle(): int
    {
        $missing = 0;

        foreach (self::EXPECTED as $table => $columns) {
            if (! Schema::hasTable($table)) {
                $this->error("missing table: {$table}");
                $missing++;

                continue;
            }

            foreach ($columns as $column) {
                if (! Schema::hasColumn($table, $column)) {
                    $this->error("missing column: {$table}.{$column}");
                    $missing++;
                }
            }
        }

        if ($missing > 0) {
            $this->error("{$missing} missing schema item(s); boot Strapi against this database to create them.");

            return self::FAILURE;
        }

        $this->info('strapi schema ok');

        return self::SUCCESS;
    }
}
`;
