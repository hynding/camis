import type { ContentType } from "@camis/ir-schema";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames } from "./names";
import type { ForeignKeyColumn, PivotTable } from "./relations";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  return `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${table}_table.php`;
};

export const foreignKeysMigrationFilename = (ct: ContentType, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_add_${filamentNames(ct).table}_foreign_keys.php`;

export const pivotMigrationFilename = (pivot: PivotTable, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${pivot.table}_table.php`;

export const emitMigration = (
  ct: ContentType,
  fkColumns: string[] = [],
  extraEmits: FieldEmit[] = [],
  options: { documentId?: boolean; draftPublish?: boolean; localized?: boolean } = {},
): string => {
  const names = filamentNames(ct);
  // Strapi 5 addresses a document by documentId, so the Strapi API style needs the column. A
  // draft-and-publish document has two rows, its draft and its published version, and a localized
  // one a row per locale, all sharing it.
  const manyRows = options.draftPublish === true || options.localized === true;
  const documentIdCol = options.documentId
    ? `\n            $table->string('document_id', 24)->${manyRows ? "index" : "unique"}();`
    : "";
  // A document's rows can carry the same values, so a unique field cannot be unique per row (a
  // reported gap).
  const migration = (e: FieldEmit): string =>
    manyRows ? e.migration.replace("->unique()", "") : e.migration;
  const fieldCols = [
    ...ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component")
      .map((f) => emitField(f)),
    ...extraEmits,
  ].map((e) => `            ${migration(e)};`);
  const publishedAtCol = [
    ...(options.draftPublish ? ["            $table->timestamp('published_at')->nullable();"] : []),
    ...(options.localized ? ["            $table->string('locale', 16)->index();"] : []),
  ];
  const fkCols = fkColumns.map((c) => `            ${c};`);
  const columns = [...fieldCols, ...fkCols, ...publishedAtCol].join("\n");
  return `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${names.table}', function (Blueprint $table): void {
            $table->id();${documentIdCol}
${columns}
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${names.table}');
    }
};
`;
};

export const emitPivotMigration = (pivot: PivotTable): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${pivot.table}', function (Blueprint $table): void {
            $table->foreignId('${pivot.leftFk}')->constrained('${pivot.leftTable}')->cascadeOnDelete();
            $table->foreignId('${pivot.rightFk}')->constrained('${pivot.rightTable}')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${pivot.table}');
    }
};
`;

/** Constrains keys a create-table migration declared bare, once the tables they point at exist. */
export const emitForeignKeysMigration = (ct: ContentType, keys: ForeignKeyColumn[]): string => {
  const table = filamentNames(ct).table;
  const add = keys.map(
    (k) =>
      `            $table->foreign('${k.column}')->references('id')->on('${k.table}')${k.onDelete};`,
  );
  const drop = keys.map((k) => `            $table->dropForeign(['${k.column}']);`);
  return `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('${table}', function (Blueprint $table): void {
${add.join("\n")}
        });
    }

    public function down(): void
    {
        Schema::table('${table}', function (Blueprint $table): void {
${drop.join("\n")}
        });
    }
};
`;
};
