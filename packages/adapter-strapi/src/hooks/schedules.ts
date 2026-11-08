import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument, Schedule } from "@camis/ir-schema";
import { hookSlug } from "./names";

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

const stub = (s: Schedule): string => `import type { Core } from "@strapi/strapi";

// Ring 2 scheduled task — hand-written. camis seeds this once and never overwrites it.
// Strapi runs it on the cron schedule "${s.cron}" (config/cron-tasks.ts).
export default async ({ strapi }: { strapi: Core.Strapi }): Promise<void> => {
  // TODO: implement the task "${s.name}".
};
`;

const cronTasks = (schedules: Schedule[]): string =>
  withMarker(`${[...schedules]
    .sort((a, b) => hookSlug(a.name).localeCompare(hookSlug(b.name)))
    .map((s) => `import ${lower(s.name)} from "../src/cron/${hookSlug(s.name)}";`)
    .join("\n")}

export default {
${schedules
  .map((s) => `  ${lower(s.name)}: { task: ${lower(s.name)}, options: { rule: "${s.cron}" } },`)
  .join("\n")}
};
`);

/** The IR's schedules as Strapi's cron tasks: config/cron-tasks.ts and a seeded task each. */
export const emitScheduleFiles = (doc: IrDocument): GeneratedFile[] => {
  const schedules = doc.schedules ?? [];
  if (schedules.length === 0) return [];
  return [
    ...schedules.map(
      (s): GeneratedFile => ({
        path: `src/cron/${hookSlug(s.name)}.ts`,
        content: stub(s),
        mode: "seed",
      }),
    ),
    { path: "config/cron-tasks.ts", content: cronTasks(schedules) },
  ];
};
