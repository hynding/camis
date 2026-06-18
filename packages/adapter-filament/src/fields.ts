import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

export interface FieldEmit {
  column: string;
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
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
  "media",
]);
export const isSupportedField = (t: string): boolean => SUPPORTED.has(t);

// Emit a string default as a single-quoted PHP literal, escaping backslashes and single quotes
// so an author-controlled default cannot break out of (or inject code into) the generated PHP.
const phpDefault = (v: unknown): string =>
  typeof v === "boolean"
    ? v
      ? "true"
      : "false"
    : typeof v === "number"
      ? JSON.stringify(v)
      : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

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
  const maxLen = typeof f.maxLength === "number" ? `, ${f.maxLength}` : "";
  switch (field.type) {
    case "string":
    case "uid":
    case "email":
      return {
        migration: `$table->string('${c}'${maxLen})`,
        formComponent: `TextInput::make('${c}')${field.type === "email" ? "->email()" : ""}`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
      };
    case "text":
      return {
        migration: `$table->text('${c}')`,
        formComponent: `Textarea::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\Textarea",
        tableImport: TEXT_COLUMN,
      };
    case "richText":
      return {
        migration: `$table->longText('${c}')`,
        formComponent: `RichEditor::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\RichEditor",
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
    case "decimal":
      return {
        migration: `$table->decimal('${c}')`,
        formComponent: `TextInput::make('${c}')->numeric()`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
        cast: "'decimal:2'",
      };
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
      const opts = values.map((v) => `'${v}' => '${v}'`).join(", ");
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
        formComponent: `KeyValue::make('${c}')`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: "Filament\\Forms\\Components\\KeyValue",
        tableImport: TEXT_COLUMN,
        cast: "'array'",
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

export const emitField = (field: Field): FieldEmit => {
  const f = field as Field & Record<string, unknown>;
  const column = snakeColumn(field.name);
  const b = base(field, column);
  const required = f.required === true;
  const unique = f.unique === true;
  const migration =
    b.migration +
    (required ? "" : "->nullable()") +
    (unique ? "->unique()" : "") +
    (f.default !== undefined ? `->default(${phpDefault(f.default)})` : "");
  const formComponent =
    b.formComponent + (required ? "->required()" : "") + (unique ? "->unique()" : "");
  return {
    column,
    migration,
    formComponent,
    tableColumn: b.tableColumn,
    formImport: b.formImport,
    tableImport: b.tableImport,
    ...(b.cast ? { cast: b.cast } : {}),
  };
};
