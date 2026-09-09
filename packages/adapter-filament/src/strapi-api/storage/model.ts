import type { ContentType, IrDocument } from "@camis/ir-schema";
import { emitField } from "../../fields";
import { PHP_MARKER } from "../../hooks/names";
import { filamentNames } from "../../names";
import type { MappedComponent, MappedScalar } from "./component-map";
import { linkColumns, linkTable, strapiTable, type RelationField } from "./names";

// The Strapi-owned datetime columns every content row carries, regardless of the IR: Strapi 5
// writes them itself, so they never appear as IR fields but always need the per-driver cast.
const STRAPI_DATETIME_COLUMNS = ["created_at", "updated_at", "published_at"];

const sp = (n: number): string => " ".repeat(n);

// Wrap an author-controlled string as a single-quoted PHP literal, escaping backslashes and single
// quotes so it cannot break out of (or inject code into) the generated PHP.
const phpString = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const phpBool = (b: boolean): string => (b ? "true" : "false");
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Renders a PHP list literal, one already-indented item per line, or `[]` when empty. */
const listLiteral = (closeIndent: number, items: string[]): string =>
  items.length === 0 ? "[]" : `[\n${items.join("\n")}\n${sp(closeIndent)}]`;

/** Renders `['column' => ..., 'flatAttribute' => ..., 'type' => ...]` at the given indent. */
const scalarLiteral = (s: MappedScalar, indent: number): string => {
  const kv = indent + 4;
  return [
    `${sp(indent)}[`,
    `${sp(kv)}'column' => ${phpString(s.column)},`,
    `${sp(kv)}'flatAttribute' => ${phpString(s.flatAttribute)},`,
    `${sp(kv)}'type' => ${phpString(s.type)},`,
    `${sp(indent)}],`,
  ].join("\n");
};

/**
 * Renders one `COMPONENT_MAP` entry, recursively, carrying only the keys
 * `App\Support\StrapiComponents` reads: `field`, `repeatable`, `relationName` (repeatable only),
 * `table`, `type`, `cmpsTable`, `scalars` and `nested`. `wireKey`/`flatPrefix` are TS-only naming
 * bookkeeping the PHP runtime never consults, so they are omitted.
 */
const componentLiteral = (c: MappedComponent, indent: number): string => {
  const kv = indent + 4;
  const lines = [`${sp(indent)}[`];
  lines.push(`${sp(kv)}'field' => ${phpString(c.field)},`);
  lines.push(`${sp(kv)}'repeatable' => ${phpBool(c.repeatable)},`);
  if (c.repeatable && c.relationName !== undefined) {
    lines.push(`${sp(kv)}'relationName' => ${phpString(c.relationName)},`);
  }
  lines.push(`${sp(kv)}'table' => ${phpString(c.table)},`);
  lines.push(`${sp(kv)}'type' => ${phpString(c.type)},`);
  lines.push(`${sp(kv)}'cmpsTable' => ${phpString(c.cmpsTable)},`);
  const scalars = c.scalars.map((s) => scalarLiteral(s, kv + 4));
  lines.push(`${sp(kv)}'scalars' => ${listLiteral(kv, scalars)},`);
  const nested = c.nested.map((n) => componentLiteral(n, kv + 4));
  lines.push(`${sp(kv)}'nested' => ${listLiteral(kv, nested)},`);
  lines.push(`${sp(indent)}],`);
  return lines.join("\n");
};

const componentMapLiteral = (map: MappedComponent[]): string =>
  listLiteral(
    4,
    map.map((c) => componentLiteral(c, 8)),
  );

const stringListLiteral = (items: string[]): string =>
  items.length === 0
    ? "[]"
    : `[\n${items.map((s) => `${sp(8)}${phpString(s)},`).join("\n")}\n${sp(4)}]`;

/**
 * `COMPONENT_ATTRIBUTES` (every non-repeatable scalar's `flatAttribute`, at any nesting depth) and
 * `COMPONENT_RELATIONS` (every repeatable's `relationName`, at any nesting depth), both in IR
 * field order. A repeatable component's whole subtree is loaded as child rows (its scalars live on
 * those rows, not on the owner), so recursion stops the moment a repeatable node is reached —
 * whatever lives underneath it is the runtime loader's concern, not the owner model's.
 */
const collectComponentNames = (
  nodes: MappedComponent[],
): { attributes: string[]; relations: string[] } => {
  const attributes: string[] = [];
  const relations: string[] = [];
  const walk = (list: MappedComponent[]): void => {
    for (const n of list) {
      if (n.repeatable) {
        if (n.relationName !== undefined) relations.push(n.relationName);
        continue;
      }
      attributes.push(...n.scalars.map((s) => s.flatAttribute));
      walk(n.nested);
    }
  };
  walk(nodes);
  return { attributes, relations };
};

/**
 * Emits the Eloquent model for one content type on the Strapi storage layout: its own table
 * (Task 5's `strapiTable`), `$fillable` restricted to real scalar columns plus the three Strapi-
 * owned columns, `casts()` with `StrapiDateTime` for every datetime column, the three constants
 * `StrapiComponentAttributes` (Task 6) reads, and a `BelongsToMany` + `?int` accessor for each
 * owning relation — the link tables Strapi itself created, not a foreign-key column on this table.
 *
 * `observed` mirrors `model.ts`: a Ring 2 hook or an AI field emits
 * `app/Observers/<Model>Observer.php`, and Laravel only calls it when the model declares
 * `#[ObservedBy]` — so without this the observer file would be dead code on this layout.
 */
export const emitStorageModel = (
  ct: ContentType,
  doc: IrDocument,
  map: MappedComponent[],
  scopeMethod: string | undefined,
  observed: boolean = false,
): string => {
  const byName = new Map(doc.contentTypes.map((c) => [c.name, c]));
  const modelName = filamentNames(ct).model;
  const table = strapiTable(ct);

  const scalarFields = ct.fields.filter(
    (f) => f.type !== "relation" && f.type !== "component" && f.type !== "dynamicZone",
  );
  const emits = scalarFields.map((field) => ({ field, emit: emitField(field) }));

  const fillableCols = [
    ...emits.map((e) => e.emit.column),
    "document_id",
    "published_at",
    "locale",
  ].filter((c, i, arr) => arr.indexOf(c) === i);
  const fillableLines = fillableCols.map((c) => `        '${c}',`).join("\n");

  const castPairs: Array<[string, string]> = [];
  const seenCastColumns = new Set<string>();
  const addCast = (column: string, cast: string): void => {
    if (seenCastColumns.has(column)) return;
    seenCastColumns.add(column);
    castPairs.push([column, cast]);
  };
  for (const column of STRAPI_DATETIME_COLUMNS) addCast(column, "StrapiDateTime::class");
  for (const { field, emit } of emits) {
    if (field.type === "dateTime" || field.type === "timestamp") {
      addCast(emit.column, "StrapiDateTime::class");
    } else if (field.type === "date" || field.type === "time") {
      // Deliberately uncast (spec 17i): Strapi stores a `date` as a bare `Y-m-d` and a `time` as
      // `H:i:s.SSS`, and serves them back verbatim. Laravel's 'date' cast would hydrate a Carbon
      // and write `Y-m-d H:i:s` into the same column, so the two backends would disagree on the
      // value they each read. Passing the string through keeps them identical.
      continue;
    } else if (emit.cast !== undefined) {
      addCast(emit.column, emit.cast);
    }
  }
  const castLines = castPairs
    .map(([column, cast]) => `            '${column}' => ${cast},`)
    .join("\n");

  const { attributes, relations } = collectComponentNames(map);

  const relationBlocks: string[] = [];
  let usesBelongsToMany = false;
  for (const rawField of ct.fields) {
    if (rawField.type !== "relation") continue;
    const f = rawField as RelationField;
    if (f.relationKind !== "manyToOne" && f.relationKind !== "oneToOne") continue; // Task 11 gaps the rest
    usesBelongsToMany = true;
    const targetCt = byName.get(f.target);
    const targetModel = targetCt ? filamentNames(targetCt).model : f.target;
    const linkTableName = linkTable(ct, f.name);
    const cols = linkColumns(ct, f); // `ord` is a write-time concern (StrapiRows::link); never referenced here
    const accessor = `get${capitalize(f.name)}IdAttribute`;
    relationBlocks.push(
      `    public function ${f.name}(): BelongsToMany\n` +
        `    {\n` +
        `        return $this->belongsToMany(${targetModel}::class, '${linkTableName}', '${cols.local}', '${cols.foreign}');\n` +
        `    }\n\n` +
        `    public function ${accessor}(): ?int\n` +
        `    {\n` +
        `        return $this->${f.name}->first()?->id;\n` +
        `    }`,
    );
  }

  const imports = new Set<string>([
    "App\\Casts\\StrapiDateTime",
    "App\\Support\\StrapiComponentAttributes",
    "Illuminate\\Database\\Eloquent\\Model",
  ]);
  if (usesBelongsToMany) imports.add("Illuminate\\Database\\Eloquent\\Relations\\BelongsToMany");
  if (scopeMethod !== undefined) imports.add("Illuminate\\Database\\Eloquent\\Builder");
  if (observed) imports.add(`App\\Observers\\${modelName}Observer`);
  const importLines = [...imports]
    .sort()
    .map((i) => `use ${i};`)
    .join("\n");

  const methodBlocks = [...relationBlocks, ...(scopeMethod !== undefined ? [scopeMethod] : [])];
  const methodsSection = methodBlocks.length > 0 ? `\n${methodBlocks.join("\n\n")}\n` : "";

  // Empty when not observed, leaving the template byte-identical to Task 7's goldens.
  const observedAttr = observed
    ? `#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([${modelName}Observer::class])]\n`
    : "";

  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

${importLines}

${observedAttr}class ${modelName} extends Model
{
    use StrapiComponentAttributes;

    protected $table = '${table}';

    protected $fillable = [
${fillableLines}
    ];

    protected function casts(): array
    {
        return [
${castLines}
        ];
    }

    public const COMPONENT_ATTRIBUTES = ${stringListLiteral(attributes)};

    public const COMPONENT_RELATIONS = ${stringListLiteral(relations)};

    public const COMPONENT_MAP = ${componentMapLiteral(map)};
${methodsSection}}
`;
};

/**
 * `App\Models\User` on Strapi's `up_users` — the builtin the users-permissions plugin owns.
 * No `StrapiComponentAttributes`: Strapi's own user/role tables never carry component fields.
 */
export const emitStorageUserModel = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use App\\Casts\\StrapiDateTime;
use Illuminate\\Database\\Eloquent\\Relations\\BelongsToMany;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;

class User extends Authenticatable
{
    protected $table = 'up_users';

    protected $fillable = [
        'username',
        'email',
        'password',
        'provider',
        'confirmed',
        'blocked',
        'document_id',
        'published_at',
        'locale',
    ];

    protected $hidden = [
        'password',
    ];

    protected function casts(): array
    {
        return [
            'confirmed' => 'boolean',
            'blocked' => 'boolean',
            'created_at' => StrapiDateTime::class,
            'updated_at' => StrapiDateTime::class,
            'published_at' => StrapiDateTime::class,
        ];
    }

    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(UpRole::class, 'up_users_role_lnk', 'user_id', 'role_id');
    }

    public function roleType(): ?string
    {
        return $this->roles->first()?->type;
    }
}
`;

/** `App\Models\UpRole` on Strapi's `up_roles` — the users-permissions plugin's role table. */
export const emitStorageUpRoleModel = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use App\\Casts\\StrapiDateTime;
use Illuminate\\Database\\Eloquent\\Model;

class UpRole extends Model
{
    protected $table = 'up_roles';

    protected $fillable = [
        'name',
        'type',
        'description',
        'document_id',
        'published_at',
        'locale',
    ];

    protected function casts(): array
    {
        return [
            'created_at' => StrapiDateTime::class,
            'updated_at' => StrapiDateTime::class,
            'published_at' => StrapiDateTime::class,
        ];
    }
}
`;
