import { fieldApiName, type ContentType, type Field } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { filamentNames } from "../names";
import { phpSingleQuoted } from "../php-literal";
import { strapiActions } from "./strapi-actions";
import { FILE_UID } from "./media-runtime";
import { kebab } from "./names";
import type { WireScalar, WireShape } from "./wire-shape";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

export const TRANSFER_MAP_PATH = "app/Support/StrapiTransferMap.php";
export const IMPORT_ENGINE_PATH = "app/Support/StrapiImport.php";
export const IMPORT_COMMAND_PATH = "app/Console/Commands/StrapiImport.php";
export const EXPORT_ENGINE_PATH = "app/Support/StrapiExport.php";
export const EXPORT_COMMAND_PATH = "app/Console/Commands/StrapiExport.php";
/** Strapi's runtime schemas for this IR, which an export archive carries as they are. */
export const TRANSFER_SCHEMAS_PATH = "resources/strapi/schemas.jsonl";

const USER_UID = "plugin::users-permissions.user";

type RelationField = Extract<Field, { type: "relation" }>;

export interface TransferMapInput {
  emitted: ContentType[];
  shapes: ReadonlyMap<string, WireShape>;
  /** The builtin user type's name, whose relations hold a user (`assign: { owner: … }`). */
  userType: string | undefined;
  media: boolean;
  localized: boolean;
  /** The role a Strapi `authenticated` user gets here (`bundle.defaultRole`). */
  defaultRole: string | undefined;
  /** The builtin file type's name, whose grants are the upload plugin's actions. */
  fileType: string | undefined;
}

const uidOf = (ct: ContentType): string => `api::${kebab(ct.name)}.${kebab(ct.name)}`;

const indent = (depth: number): string => "    ".repeat(depth);

/** A PHP array literal, one entry per line, nested arrays indented under their key. */
const php = (value: unknown, depth: number): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string")
    return value.startsWith("\\") ? `${value}::class` : phpSingleQuoted(value);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string"))
      return `[${value.map((v) => php(v, 0)).join(", ")}]`;
    return `[\n${value.map((v) => `${indent(depth + 1)}${php(v, depth + 1)},\n`).join("")}${indent(depth)}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "[]";
  return `[\n${entries
    .map(([k, v]) => `${indent(depth + 1)}${phpSingleQuoted(k)} => ${php(v, depth + 1)},\n`)
    .join("")}${indent(depth)}]`;
};

const scalar = (s: WireScalar, from: number) => ({
  key: s.key.slice(from),
  column: s.column,
  type: s.type,
});

/** Where each key of an archived entry goes: a column, a component's columns, child rows. */
const attributes = (shape: WireShape) => {
  const out: Record<string, unknown> = {
    documentId: { column: "document_id", type: "string" },
  };
  for (const s of shape.scalars) {
    const [first] = s.key;
    if (first === undefined) continue;
    if (s.key.length === 1) {
      out[first] = { column: s.column, type: s.type };
    } else {
      const group = (out[first] ??= { component: [] }) as { component: unknown[] };
      group.component.push(scalar(s, 1));
    }
  }
  for (const child of shape.children) {
    const [first] = child.key;
    if (first === undefined) continue;
    const rows = { repeatable: child.relation, scalars: child.scalars.map((s) => scalar(s, 0)) };
    if (child.key.length === 1) {
      out[first] = rows;
    } else {
      // A repeatable inside a component: its items are child rows of the entry, found under the
      // rest of its key within the component's value.
      const group = (out[first] ??= { component: [] }) as { children?: unknown[] };
      (group.children ??= []).push({ key: child.key.slice(1), ...rows });
    }
  }
  for (const zone of shape.zones) {
    out[zone.key] = {
      zone: Object.fromEntries(
        zone.members.map((m) => [
          m.uid,
          { relation: m.relation, scalars: m.scalars.map((s) => scalar(s, 0)) },
        ]),
      ),
    };
  }
  out.createdAt = { column: "created_at", type: "dateTime" };
  out.updatedAt = { column: "updated_at", type: "dateTime" };
  // A type without draft and publish keeps no publication date, nor a locale when not localized:
  // the archive's value (every Strapi entry has both) has no column to go to.
  out.publishedAt = shape.draftPublish ? { column: "published_at", type: "dateTime" } : null;
  out.locale = shape.localized ? { column: "locale", type: "string" } : null;
  return out;
};

/**
 * Where each link of an archived entry goes: the Eloquent relation that stores it. A link this
 * type declares also names its Strapi relation and the target's inverse key, which an export
 * writes it under (Strapi lists a link from the declaring side).
 */
const links = (shape: WireShape, ct: ContentType, userType: string | undefined) => {
  const out: Record<string, unknown> = {};
  const declared = (key: string, relation: string) =>
    ct.fields.find(
      (f): f is RelationField =>
        f.type === "relation" && f.name === relation && fieldApiName(f) === key,
    );
  const declaration = (f: RelationField | undefined) =>
    f === undefined ? {} : { declares: f.relationKind, inverse: f.inverse ?? null };
  for (const r of shape.relations) {
    if (r.kind === "localizations") continue;
    if (r.kind === "mediaOne" || r.kind === "mediaMany") {
      out[r.key] = { kind: "media", relation: r.relation };
      continue;
    }
    out[r.key] = {
      kind: r.kind,
      relation: r.relation,
      target: r.uid,
      required: r.kind === "belongsTo" && required(ct, r.relation),
      ...declaration(declared(r.key, r.relation)),
    };
  }
  for (const f of ct.fields) {
    if (f.type !== "relation" || f.target !== userType) continue;
    if (f.relationKind !== "manyToOne" && f.relationKind !== "oneToOne") continue;
    out[fieldApiName(f)] = {
      kind: "belongsTo",
      relation: f.name,
      target: USER_UID,
      required: f.required === true,
      ...declaration(f),
    };
  }
  return out;
};

const required = (ct: ContentType, relation: string): boolean =>
  ct.fields.some((f) => f.type === "relation" && f.name === relation && f.required === true);

/**
 * Content types in the order their rows can be inserted: a type after the types its foreign keys
 * point at, so a required one is set on insert. A cycle (only possible through optional keys)
 * keeps IR order; those keys are set once every row exists.
 */
const insertOrder = (
  emitted: ContentType[],
  shapes: ReadonlyMap<string, WireShape>,
): ContentType[] => {
  const byUid = new Map(emitted.map((ct) => [uidOf(ct), ct]));
  const done = new Set<string>();
  const order: ContentType[] = [];
  const visit = (ct: ContentType, path: Set<string>) => {
    if (done.has(ct.name) || path.has(ct.name)) return;
    path.add(ct.name);
    for (const r of shapes.get(ct.name)?.relations ?? []) {
      const target = byUid.get(r.uid);
      if (r.kind === "belongsTo" && target !== undefined && target !== ct) visit(target, path);
    }
    path.delete(ct.name);
    done.add(ct.name);
    order.push(ct);
  };
  for (const ct of emitted) visit(ct, new Set());
  return order;
};

/**
 * The generated descriptor `strapi:import` reads: for every uid a Strapi archive can hold, where
 * its entries go here. Content types come from the IR, in insert order; Strapi's plugin types map
 * onto the tables camis keeps for them, or name why they are not imported.
 */
export const emitStrapiTransferMap = (input: TransferMapInput): string => {
  const types: Record<string, unknown> = {
    [USER_UID]: { plugin: "user", model: "\\App\\Models\\User" },
    "plugin::users-permissions.role": { plugin: "role" },
    "plugin::users-permissions.permission": {
      skip: "a role's permissions are the IR's grants, which every build writes",
    },
    [FILE_UID]: input.media
      ? { plugin: "file", model: "\\App\\Models\\File" }
      : { skip: "this project keeps no media library" },
    "plugin::upload.folder": {
      skip: "camis keeps a file's folder path, not the media library's folders",
    },
    "plugin::i18n.locale": input.localized
      ? { plugin: "locale", model: "\\App\\Models\\Locale" }
      : { skip: "this project keeps no locales" },
  };
  for (const ct of insertOrder(input.emitted, input.shapes)) {
    const shape = input.shapes.get(ct.name);
    if (shape === undefined) continue;
    types[uidOf(ct)] = {
      model: `\\App\\Models\\${filamentNames(ct).model}`,
      draftPublish: shape.draftPublish,
      localized: shape.localized,
      attributes: attributes(shape),
      links: links(shape, ct, input.userType),
    };
  }
  return (
    header("App\\Support") +
    `
/**
 * Where each type of a Strapi export archive goes in this app, for \`strapi:import\` and
 * \`strapi:export\`. Generated from the IR: an entry's \`attributes\` name the column (or a
 * component's columns and child rows, or the child rows) each key of an archived entry is written to, \`null\`
 * when this app keeps no such value; its \`links\` name the Eloquent relation that stores each
 * link, and for a link the type declares, its Strapi relation and the target's inverse key.
 */
final class StrapiTransferMap
{
    /** The role a Strapi \`authenticated\` user gets, and any user whose role this app lacks. */
    public const DEFAULT_ROLE = ${input.defaultRole === undefined ? "null" : phpSingleQuoted(input.defaultRole)};

    public const TYPES = ${php(types, 1)};

    /** The users-permissions actions each of this app's permissions is in Strapi, for \`strapi:export\`. */
    public const ACTIONS = ${php(strapiActions(input), 1)};
}
`
  );
};

/** The command: Strapi's `strapi import` options, its prompt, and its summary. */
export const emitStrapiImportCommand = (): string =>
  header("App\\Console\\Commands") +
  String.raw`
use App\Support\StrapiImport as Import;
use Illuminate\Console\Command;

/** Strapi's ` +
  "`strapi import`" +
  String.raw`: reads an archive ` +
  "`strapi export`" +
  String.raw` wrote into this app. */
final class StrapiImport extends Command
{
    protected $signature = 'strapi:import
        {--f|file= : Path and filename for the Strapi export file you want to import}
        {--k|key= : Provide encryption key in command instead of using the prompt}
        {--force : Automatically answer "yes" to all prompts, including potentially destructive requests, and run non-interactively}
        {--only= : Include only these types of data (plus schemas). Available types: content,files,config}
        {--exclude= : Exclude data using comma-separated types. Available types: content,files,config}';

    protected $description = 'Import data from a Strapi export archive';

    public function handle(): int
    {
        $file = (string) $this->option('file');
        if ($file === '') {
            $this->error('Missing required option: --file');

            return self::FAILURE;
        }
        try {
            $stages = Import::stages(self::list($this->option('only')), self::list($this->option('exclude')));
            $key = $this->option('key');
            if (str_ends_with($file, '.enc') && ($key === null || $key === '')) {
                $key = (string) $this->secret('Please enter your decryption key');
            }
            $import = Import::open($file, is_string($key) && $key !== '' ? $key : null);
            $diffs = $import->schemaDiffs();
            if ($diffs !== []) {
                $this->error('The source and destination provide incompatible schemas:');
                foreach ($diffs as $diff) {
                    $this->line("  - {$diff}");
                }

                return self::FAILURE;
            }
            if (! $this->option('force') && ! $this->confirm('The import will delete your existing data! Are you sure you want to proceed?')) {
                $this->line('Aborting import.');

                return self::FAILURE;
            }
            $counts = $import->run($stages);
        } catch (\Throwable $error) {
            $this->error("Import process failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Type', 'Count'], array_map(fn ($type, $count) => [$type, $count], array_keys($counts), $counts));
        foreach ($import->skipped() as $type => $reason) {
            $this->line("Not imported: {$type} ({$reason})");
        }
        $this->info('Import process has been completed successfully!');

        return self::SUCCESS;
    }

    /** @return list<string>|null */
    private static function list(mixed $option): ?array
    {
        return is_string($option) && $option !== '' ? array_map('trim', explode(',', $option)) : null;
    }
}
`;

/** The command: Strapi's `strapi export` options, its key prompt, and its summary. */
export const emitStrapiExportCommand = (): string =>
  header("App\\Console\\Commands") +
  String.raw`
use App\Support\StrapiExport as Export;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

/** Strapi's ` +
  "`strapi export`" +
  String.raw`: writes this app's data as the archive ` +
  "`strapi import`" +
  String.raw` reads. */
final class StrapiExport extends Command
{
    protected $signature = 'strapi:export
        {--f|file= : Name to use for exported file (without extensions)}
        {--k|key= : Provide encryption key in command instead of using the prompt}
        {--no-encrypt : Disables "aes-128-ecb" encryption of the output file}
        {--no-compress : Disables gzip compression of output file}
        {--only= : Include only these types of data (plus schemas). Available types: content,files,config}
        {--exclude= : Exclude data using comma-separated types. Available types: content,files,config}';

    protected $description = 'Export data from this app to a Strapi export archive';

    public function handle(): int
    {
        $file = (string) ($this->option('file') ?: 'export_' . CarbonImmutable::now()->format('YmdHis'));
        try {
            $stages = Export::stages(self::list($this->option('only')), self::list($this->option('exclude')));
            $key = null;
            if (! $this->option('no-encrypt')) {
                $key = (string) ($this->option('key') ?: $this->secret('Please enter an encryption key'));
                if ($key === '') {
                    $this->error('Provide a key with --key, or export without encryption with --no-encrypt');

                    return self::FAILURE;
                }
            }
            $written = Export::write($file, $stages, ! $this->option('no-compress'), $key);
        } catch (\Throwable $error) {
            $this->error("Export process failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Type', 'Count'], array_map(fn ($type, $count) => [$type, $count], array_keys($written['counts']), $written['counts']));
        $this->line("Export archive is in {$written['path']}");
        $this->info('Export process has been completed successfully!');

        return self::SUCCESS;
    }

    /** @return list<string>|null */
    private static function list(mixed $option): ?array
    {
        return is_string($option) && $option !== '' ? array_map('trim', explode(',', $option)) : null;
    }
}
`;
