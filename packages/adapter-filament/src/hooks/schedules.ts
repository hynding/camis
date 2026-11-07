import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument, Schedule } from "@camis/ir-schema";
import { PHP_MARKER } from "./names";

const contract = (s: Schedule): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

interface ${s.name}Task
{
    /**
     * Runs on the cron schedule "${s.cron}", where cron calls \`php artisan schedule:run\`.
     */
    public function run(): void;
}
`;

const stub = (s: Schedule): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${s.name}Task;

// Ring 2 scheduled task — hand-written. camis seeds this once and never overwrites it.
final class ${s.name} implements ${s.name}Task
{
    public function run(): void
    {
        // TODO: implement the task "${s.name}" (cron "${s.cron}").
    }
}
`;

// Loaded from routes/console.php (patched by \`camis scaffold\`), where Laravel defines its schedule.
const registry = (schedules: Schedule[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

${[...schedules.map((s) => `App\\Hooks\\${s.name}`), "Illuminate\\Support\\Facades\\Schedule"]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

// The IR's schedules, as Strapi's cron tasks. They run only where cron calls
// \`php artisan schedule:run\` every minute (DEPLOY.md); without it nothing here runs.
${schedules
  .map(
    (s) =>
      `Schedule::call(fn () => app(${s.name}::class)->run())->cron('${s.cron}')->name('${s.name}');`,
  )
  .join("\n")}
`;

/** The IR's schedules: a seam each, and the file that hands them to Laravel's scheduler. */
export const emitScheduleFiles = (doc: IrDocument): GeneratedFile[] => {
  const schedules = doc.schedules ?? [];
  if (schedules.length === 0) return [];
  return [
    ...schedules.flatMap((s): GeneratedFile[] => [
      { path: `app/Hooks/Contracts/${s.name}Task.php`, content: contract(s) },
      { path: `app/Hooks/${s.name}.php`, content: stub(s), mode: "seed" },
    ]),
    { path: "routes/schedule.php", content: registry(schedules) },
  ];
};
