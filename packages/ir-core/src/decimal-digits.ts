import type { ComponentFieldT, Field, IrDocument, IrErrorLocation } from "@camis/ir-schema";

/**
 * The significant digits of which a binary double keeps every decimal exactly (C's DBL_DIG): any
 * value of at most 15 digits reads back from a double as it was written, a longer one may not.
 */
export const DOUBLE_DIGITS = 15;

export interface DecimalDigits {
  precision: number;
  scale: number;
}

type AnyField = Field | ComponentFieldT;

/** A decimal's stated digits, or undefined where it states none and a target keeps its default. */
export const decimalDigits = (field: AnyField): DecimalDigits | undefined =>
  field.type === "decimal" && field.precision !== undefined && field.scale !== undefined
    ? { precision: field.precision, scale: field.scale }
    : undefined;

/** Whether a decimal states more digits than `digits`, the digits a target's number type keeps. */
export const digitsBeyond = (field: AnyField, digits: number): boolean =>
  (decimalDigits(field)?.precision ?? 0) > digits;

/** Whether a decimal states more digits than a double keeps, so its values must not pass through one. */
export const beyondDouble = (field: AnyField): boolean => digitsBeyond(field, DOUBLE_DIGITS);

export interface LocatedDecimal {
  /** The content type or component holding the field, and the field. */
  location: IrErrorLocation;
  digits: DecimalDigits;
}

/** Every decimal stating more digits than `kept`, a component's included, located. */
export const decimalsBeyond = (doc: IrDocument, kept: number): LocatedDecimal[] => {
  const located = (holder: IrErrorLocation, fields: readonly AnyField[]): LocatedDecimal[] =>
    fields.flatMap((field) => {
      const digits = decimalDigits(field);
      return digits !== undefined && digitsBeyond(field, kept)
        ? [{ location: { ...holder, field: field.name }, digits }]
        : [];
    });
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};

/** Every decimal stating more digits than a double keeps, a component's included, located. */
export const decimalsBeyondDouble = (doc: IrDocument): LocatedDecimal[] =>
  decimalsBeyond(doc, DOUBLE_DIGITS);
