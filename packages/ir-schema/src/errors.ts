export type IrErrorCode =
  | "invalid_document"
  | "invalid_identifier"
  | "empty_enumeration"
  | "invalid_min_max"
  | "enum_default_not_member"
  | "duplicate_field"
  | "empty_dynamic_zone"
  | "reserved_field_name"
  | "invalid_default_type"
  | "unknown_uid_target"
  | "unknown_relation_target"
  | "unknown_component_ref"
  | "duplicate_content_type_name"
  | "duplicate_component_name"
  | "cyclic_component_reference"
  | "inverse_field_collision";

export interface IrErrorLocation {
  contentType?: string;
  component?: string;
  field?: string;
  rule?: string;
}

export interface IrError {
  code: IrErrorCode;
  message: string;
  location: IrErrorLocation;
  path: (string | number)[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: IrError[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (errors: IrError[]): Result<never> => ({ ok: false, errors });
