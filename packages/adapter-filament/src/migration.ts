import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  const seq = String(ordinal).padStart(6, "0");
  return `database/migrations/0000_00_00_${seq}_create_${table}_table.php`;
};

export const emitMigration = (ct: ContentType): string => {
  const names = filamentNames(ct);
  const columns = ct.fields
    .map(emitField)
    .map((e) => `            ${e.migration};`)
    .join("\n");
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
