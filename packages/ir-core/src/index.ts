export { normalize } from "./normalize";
export { validateInvariants } from "./invariants";
export { validate } from "./validate";
export { humanize, pluralize, snakeCase } from "./inflect";
export { reservedNameGaps } from "./reserved-names";
export type {
  FieldHolder,
  ItemTable,
  KeptNames,
  ReservedNameOptions,
  TargetName,
  TargetNames,
} from "./reserved-names";
export { DOUBLE_DIGITS, beyondDouble, decimalDigits, decimalsBeyondDouble } from "./decimal-digits";
export type { DecimalDigits, LocatedDecimal } from "./decimal-digits";
