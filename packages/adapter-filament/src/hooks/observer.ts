import type { ContentType, Hook, HookTrigger } from "@camis/ir-schema";
import { filamentNames, snakeColumn } from "../names";
import { PHP_MARKER } from "./names";

type ObserverMethod = "creating" | "created" | "updating" | "updated" | "deleting" | "deleted";

// Eloquent's model event for each lifecycle trigger, in the order a record meets them.
const METHOD: Record<Exclude<HookTrigger, "onPublish">, ObserverMethod> = {
  beforeCreate: "creating",
  afterCreate: "created",
  beforeUpdate: "updating",
  afterUpdate: "updated",
  beforeDelete: "deleting",
  afterDelete: "deleted",
};
const METHODS: ObserverMethod[] = [
  "creating",
  "created",
  "updating",
  "updated",
  "deleting",
  "deleted",
];

const indent = (code: string, by: string): string =>
  code
    .split("\n")
    .map((line) => by + line)
    .join("\n");

// Runs the hook on the record's fields and writes what it returns back to the record.
const run = (h: Hook): string => {
  const input = h.input.map((f) => `'${f.name}' => $record->${snakeColumn(f.name)}`).join(", ");
  const call = `(new ${h.name}())->run([${input}]);`;
  if (h.output.length === 0) return call;
  return [
    `$out = ${call}`,
    ...h.output.map((f) => `$record->${snakeColumn(f.name)} = $out['${f.name}'];`),
  ].join("\n");
};

// On the publish transition the record is already written, so what the hook returns is saved again.
const onPublish = (h: Hook): string =>
  `if ($record->wasChanged('published_at') && $record->published_at !== null) {
${indent(run(h), "    ")}${h.output.length > 0 ? "\n    $record->saveQuietly();" : ""}
}`;

// A draft-and-publish document's published version is a row of its own, created on first publish.
const onFirstPublish = (h: Hook): string =>
  `if ($record->published_at !== null) {
${indent(run(h), "    ")}${h.output.length > 0 ? "\n    $record->saveQuietly();" : ""}
}`;

const blocks = (h: Hook, ct: ContentType, method: ObserverMethod): string[] => {
  if (h.trigger !== "onPublish") return METHOD[h.trigger] === method ? [run(h)] : [];
  if (method === "updated") return [onPublish(h)];
  if (method === "created" && ct.options?.draftPublish === true) return [onFirstPublish(h)];
  return [];
};

/** The content type's Eloquent observer, which runs each of its hooks on the model event it names. */
export const emitHookObserver = (hooks: Hook[], ct: ContentType): string => {
  const n = filamentNames(ct);
  const methods = METHODS.map((method) => ({
    method,
    body: hooks.flatMap((h) => blocks(h, ct, method)),
  }))
    .filter((m) => m.body.length > 0)
    .map(
      ({ method, body }) => `    public function ${method}(${n.model} $record): void
    {
${indent(body.join("\n"), "        ")}
    }`,
    )
    .join("\n\n");
  const uses = [...new Set(hooks.map((h) => `App\\Hooks\\${h.name}`)), `App\\Models\\${n.model}`]
    .sort()
    .map((u) => `use ${u};`)
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Observers;

${uses}

class ${n.model}Observer
{
${methods}
}
`;
};
