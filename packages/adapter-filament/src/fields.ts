import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

export type ScalarType = "string" | "text" | "boolean" | "integer" | "dateTime";

export interface FieldEmit {
  column: string;
  required: boolean;
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
}

const SCALARS = new Set<string>(["string", "text", "boolean", "integer", "dateTime"]);
export const isScalar6A = (t: string): t is ScalarType => SCALARS.has(t);

type Builder = (c: string) => Omit<FieldEmit, "column" | "required">;

const MAP: Record<ScalarType, Builder> = {
  string: (c) => ({
    migration: `$table->string('${c}')`,
    formComponent: `TextInput::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\TextInput",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  text: (c) => ({
    migration: `$table->text('${c}')`,
    formComponent: `Textarea::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\Textarea",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  boolean: (c) => ({
    migration: `$table->boolean('${c}')`,
    formComponent: `Toggle::make('${c}')`,
    tableColumn: `IconColumn::make('${c}')->boolean()`,
    formImport: "Filament\\Forms\\Components\\Toggle",
    tableImport: "Filament\\Tables\\Columns\\IconColumn",
    cast: "'boolean'",
  }),
  integer: (c) => ({
    migration: `$table->integer('${c}')`,
    formComponent: `TextInput::make('${c}')->numeric()`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\TextInput",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  dateTime: (c) => ({
    migration: `$table->dateTime('${c}')`,
    formComponent: `DateTimePicker::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')->dateTime()`,
    formImport: "Filament\\Forms\\Components\\DateTimePicker",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
    cast: "'datetime'",
  }),
};

export const emitField = (field: Field): FieldEmit => {
  const column = snakeColumn(field.name);
  const base = MAP[field.type as ScalarType](column);
  return { column, required: (field as { required?: boolean }).required === true, ...base };
};
