import type { ContentType } from "@camis/ir-schema";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames } from "./names";
import type { PivotTable } from "./relations";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  return `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${table}_table.php`;
};

export const pivotMigrationFilename = (pivot: PivotTable, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${pivot.table}_table.php`;

export const emitMigration = (
  ct: ContentType,
  fkColumns: string[] = [],
  extraEmits: FieldEmit[] = [],
  options: { documentId?: boolean; draftPublish?: boolean } = {},
): string => {
  const names = filamentNames(ct);
  // Strapi 5 addresses a document by documentId, so the Strapi API style needs the column. A
  // draft-and-publish document has two rows, its draft and its published version, sharing it.
  const documentIdCol = options.documentId
    ? `\n            $table->string('document_id', 24)->${options.draftPublish ? "index" : "unique"}();`
    : "";
  // Both versions carry the same values, so a unique field cannot be unique per row (a reported gap).
  const migration = (e: FieldEmit): string =>
    options.draftPublish ? e.migration.replace("->unique()", "") : e.migration;
  const fieldCols = [
    ...ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component")
      .map((f) => emitField(f)),
    ...extraEmits,
  ].map((e) => `            ${migration(e)};`);
  const publishedAtCol = options.draftPublish
    ? ["            $table->timestamp('published_at')->nullable();"]
    : [];
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
