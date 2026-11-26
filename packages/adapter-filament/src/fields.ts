import { decimalDigits, type DecimalDigits } from "@camis/ir-core";
import {
  enforcedLength,
  holdsTextColumn,
  isStringLike,
  stringColumn,
  textTier,
  type StringColumn,
} from "@camis/adapter-kernel";
import type { Field } from "@camis/ir-schema";
import { beyondPhpFloat } from "./decimals";
import { snakeColumn } from "./names";
import { phpSingleQuoted, phpValue } from "./php-literal";

export interface FieldEmit {
  column: string;
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
  /** A decimal's stated digits, at which an API writes it. */
  decimalDigits?: DecimalDigits;
  /** A unique field's rule in `formComponent`, which a form whose rows share values leaves out. */
  uniqueRule?: string;
  /**
   * The length in characters every write path checks a text-like field at: its bound, or its
   * column's length where an index caps the column below it.
   */
  maxLength?: number;
  /**
   * The default the model applies, as a PHP literal, where the column is a text column: MySQL takes
   * no default on one, and the migration serves every database.
   */
  modelDefault?: string;
}

const TEXT_INPUT = "Filament\\Forms\\Components\\TextInput";
const TEXT_COLUMN = "Filament\\Tables\\Columns\\TextColumn";

const SUPPORTED = new Set<string>([
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "integer",
  "bigInteger",
  "float",
  "decimal",
  "boolean",
  "enumeration",
  "date",
  "time",
  "dateTime",
  "timestamp",
  "json",
  "blocks",
  "color",
  "media",
]);
export const isSupportedField = (t: string): boolean => SUPPORTED.has(t);

/** A pattern's source as a PCRE: delimited by `~`, with every unescaped `~` in it escaped. */
const pcre = (source: string): string => {
  let out = "";
  let escaped = false;
  for (const ch of source) {
    out += ch === "~" && !escaped ? "\\~" : ch;
    escaped = ch === "\\" && !escaped;
  }
  return `~${out}~`;
};

const phpDefault = (v: unknown): string =>
  typeof v === "boolean"
    ? v
      ? "true"
      : "false"
    : typeof v === "number"
      ? JSON.stringify(v)
      : phpSingleQuoted(String(v));

/**
 * A decimal's column: Laravel's default (8, 2) where it states no digits, else its own. SQLite keeps
 * a decimal column's values as doubles, which PDO reads as PHP floats of 14 significant digits, so a
 * decimal beyond a PHP float is text there, which keeps every digit; the other databases keep it as
 * DECIMAL. The driver is the connection's at migration time, so one migration serves every
 * database.
 */
const decimalColumn = (field: Field, c: string): string => {
  const digits = decimalDigits(field);
  if (digits === undefined) return `$table->decimal('${c}')`;
  const decimal = `$table->decimal('${c}', ${digits.precision}, ${digits.scale})`;
  if (!beyondPhpFloat(field)) return decimal;
  // Its digits, a sign and a point.
  const text = `$table->string('${c}', ${digits.precision + 2})`;
  return `(Schema::getConnection()->getDriverName() === 'sqlite' ? ${text} : ${decimal})`;
};

const digitsOf = (field: Field): { decimalDigits?: DecimalDigits } => {
  const digits = decimalDigits(field);
  return digits === undefined ? {} : { decimalDigits: digits };
};

/** Laravel's text column for each tier of text (MySQL's TEXT, MEDIUMTEXT and LONGTEXT). */
const TEXT_COLUMN_BY_TIER = { small: "text", medium: "mediumText", large: "longText" } as const;

/** A string's column: its own string column, or the text column of the tier holding its bound. */
const stringMigration = (column: StringColumn, c: string): string =>
  column.kind === "text"
    ? `$table->${TEXT_COLUMN_BY_TIER[column.tier]}('${c}')`
    : `$table->string('${c}'${column.length === undefined ? "" : `, ${column.length}`})`;

interface Base {
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
}

const base = (field: Field, c: string): Base => {
  const f = field as Field & Record<string, unknown>;
  switch (field.type) {
    case "string":
    case "uid":
    case "email":
      return {
        migration: stringMigration(stringColumn(field), c),
        formComponent: `TextInput::make('${c}')${field.type === "email" ? "->email()" : ""}`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
      };
    case "text":
      return {
        migration: `$table->${TEXT_COLUMN_BY_TIER[textTier(field)]}('${c}')`,
        formComponent: `Textarea::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\Textarea",
        tableImport: TEXT_COLUMN,
      };
    case "richText":
      return {
        migration: `$table->longText('${c}')`,
        // Strapi's richtext is Markdown: an HTML editor would rewrite it on the first save.
        formComponent: `MarkdownEditor::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\MarkdownEditor",
        tableImport: TEXT_COLUMN,
      };
    case "integer":
    case "bigInteger":
    case "float":
      return {
        migration: `$table->${field.type === "bigInteger" ? "bigInteger" : field.type}('${c}')`,
        formComponent: `TextInput::make('${c}')->numeric()`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
      };
    case "decimal": {
      const digits = decimalDigits(field);
      return {
        migration: decimalColumn(field, c),
        // ->numeric() makes the state a PHP float, which keeps 14 digits: a decimal stating its
        // digits is taken as text, refused as its model's cast would refuse it.
        formComponent:
          digits === undefined
            ? `TextInput::make('${c}')->numeric()`
            : `TextInput::make('${c}')->inputMode('decimal')->rule(new \\App\\Rules\\DecimalDigitsRule(${digits.precision}, ${digits.scale}))`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
        // Laravel's decimal cast answers the column as a string at the scale; a decimal stating its
        // digits is written as DecimalDigits keeps it by whatever writes through Eloquent.
        cast:
          digits === undefined
            ? "'decimal:2'"
            : `\\App\\Casts\\DecimalDigitsCast::class.':${digits.precision},${digits.scale}'`,
      };
    }
    case "boolean":
      return {
        migration: `$table->boolean('${c}')`,
        formComponent: `Toggle::make('${c}')`,
        tableColumn: `IconColumn::make('${c}')->boolean()`,
        formImport: "Filament\\Forms\\Components\\Toggle",
        tableImport: "Filament\\Tables\\Columns\\IconColumn",
        cast: "'boolean'",
      };
    case "enumeration": {
      const values = (f.values as string[] | undefined) ?? [];
      const opts = values.map((v) => `${phpSingleQuoted(v)} => ${phpSingleQuoted(v)}`).join(", ");
      return {
        migration: `$table->string('${c}')`,
        formComponent: `Select::make('${c}')->options([${opts}])`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\Select",
        tableImport: TEXT_COLUMN,
      };
    }
    case "date":
      return {
        migration: `$table->date('${c}')`,
        formComponent: `DatePicker::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')->date()`,
        formImport: "Filament\\Forms\\Components\\DatePicker",
        tableImport: TEXT_COLUMN,
        cast: "'date'",
      };
    case "time":
      return {
        migration: `$table->time('${c}')`,
        formComponent: `TimePicker::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\TimePicker",
        tableImport: TEXT_COLUMN,
      };
    case "dateTime":
    case "timestamp":
      return {
        migration: `$table->${field.type === "timestamp" ? "timestamp" : "dateTime"}('${c}')`,
        formComponent: `DateTimePicker::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')->dateTime()`,
        formImport: "Filament\\Forms\\Components\\DateTimePicker",
        tableImport: TEXT_COLUMN,
        cast: "'datetime'",
      };
    case "json":
      return {
        migration: `$table->json('${c}')`,
        formComponent: `JsonEditor::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "App\\Filament\\Forms\\JsonEditor",
        tableImport: TEXT_COLUMN,
        cast: "'array'",
      };
    case "blocks":
      return {
        migration: `$table->json('${c}')`,
        formComponent: `BlocksEditor::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')->state(fn ($record): string => \\App\\Support\\StrapiBlocks::plainText($record->${c}))->limit(50)`,
        formImport: "App\\Filament\\Forms\\BlocksEditor",
        tableImport: TEXT_COLUMN,
        cast: "'array'",
      };
    case "color":
      return {
        migration: `$table->string('${c}')`,
        formComponent: `ColorPicker::make('${c}')`,
        tableColumn: `ColorColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\ColorPicker",
        tableImport: "Filament\\Tables\\Columns\\ColorColumn",
      };
    case "media": {
      const multiple = f.multiple === true;
      return {
        migration: `$table->${multiple ? "json" : "string"}('${c}')`,
        formComponent: `FileUpload::make('${c}')${multiple ? "->multiple()" : ""}`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\FileUpload",
        tableImport: TEXT_COLUMN,
        ...(multiple ? { cast: "'array'" } : {}),
      };
    }
    default:
      return {
        migration: `$table->string('${c}')`,
        formComponent: `TextInput::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
      };
  }
};

/**
 * The form's uniqueness rule. Filament's `->unique()` compares the text as typed with the stored
 * digits, so a decimal stating its digits is compared as it will be stored, rounded to its scale.
 */
const uniqueRule = (field: Field, column: string): string => {
  const digits = decimalDigits(field);
  return digits === undefined
    ? "->unique()"
    : `->rule(fn (?string $model, ?\\Illuminate\\Database\\Eloquent\\Model $record) => new \\App\\Rules\\DecimalDigitsUniqueRule($model, '${column}', ${digits.precision}, ${digits.scale}, $record))`;
};

const TEXT_LIKE = new Set<string>(["string", "email", "uid", "text", "richText"]);

/**
 * The length a text-like field is checked at, if it states a bound: a value its column cannot hold
 * is refused as invalid rather than failing in the database.
 */
const boundOf = (field: Field): number | undefined => {
  if (isStringLike(field)) return enforcedLength(field);
  const maxLength = (field as Field & { maxLength?: unknown }).maxLength;
  return TEXT_LIKE.has(field.type) && typeof maxLength === "number" ? maxLength : undefined;
};

/**
 * Laravel's max rule, which counts a string's characters with mb_strlen, as the Strapi API style's
 * validator does. Filament's `maxLength()` would also set the input's maxlength attribute, which a
 * browser counts in UTF-16 code units, refusing a bound's worth of characters past the Basic
 * Multilingual Plane.
 */
const maxLengthRule = (maxLength: number | undefined): string =>
  maxLength === undefined ? "" : `->rule('max:${maxLength}')`;

export const emitField = (field: Field, columnOverride?: string): FieldEmit => {
  const f = field as Field & Record<string, unknown>;
  const column = columnOverride ?? snakeColumn(field.name);
  const b = base(field, column);
  const required = f.required === true;
  const unique = f.unique === true;
  const defaulted = f.default === undefined ? undefined : phpDefault(f.default);
  const modelDefault = defaulted !== undefined && holdsTextColumn(field) ? defaulted : undefined;
  const migration =
    b.migration +
    (required ? "" : "->nullable()") +
    (unique ? "->unique()" : "") +
    (defaulted !== undefined && modelDefault === undefined ? `->default(${defaulted})` : "");
  const pattern =
    typeof f.pattern === "string" ? `->regex(${phpSingleQuoted(pcre(f.pattern))})` : "";
  // A custom field's input when the project registers one under the editor's uid (see
  // App\Support\CustomFields), as Strapi's admin edits a custom field with its plugin's input.
  const input =
    field.editor === undefined
      ? b.formComponent
      : `(\\App\\Support\\CustomFields::input(${phpSingleQuoted(field.editor.name)}, '${column}', ${phpValue(field.editor.options ?? [])}) ?? ${b.formComponent})`;
  const formUnique = unique ? uniqueRule(field, column) : undefined;
  const maxLength = boundOf(field);
  const formComponent =
    input +
    (required ? "->required()" : "") +
    (formUnique ?? "") +
    pattern +
    maxLengthRule(maxLength);
  return {
    column,
    migration,
    formComponent,
    tableColumn: b.tableColumn,
    formImport: b.formImport,
    tableImport: b.tableImport,
    ...(b.cast ? { cast: b.cast } : {}),
    ...digitsOf(field),
    ...(formUnique === undefined ? {} : { uniqueRule: formUnique }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(modelDefault === undefined ? {} : { modelDefault }),
  };
};
