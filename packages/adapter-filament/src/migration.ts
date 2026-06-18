import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";
import type { PivotTable } from "./relations";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  return `database/migrations/0000_00_00_${String(ordinal).padStart(6, "0")}_create_${table}_table.php`;
};

export const pivotMigrationFilename = (pivot: PivotTable, ordinal: number): string =>
  `database/migrations/0000_00_00_${String(ordinal).padStart(6, "0")}_create_${pivot.table}_table.php`;

export const emitMigration = (ct: ContentType, fkColumns: string[] = []): string => {
  const names = filamentNames(ct);
  const fieldCols = ct.fields
    .filter((f) => f.type !== "relation")
    .map(emitField)
    .map((e) => `            ${e.migration};`);
  const fkCols = fkColumns.map((c) => `            ${c};`);
  const columns = [...fieldCols, ...fkCols].join("\n");
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
            $table->id();
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
