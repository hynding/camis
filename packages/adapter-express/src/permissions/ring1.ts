import { withMarker } from "@camis/adapter-kernel";
import { type Expression } from "@camis/expr";
import { emitTs, tsRuntimeSource } from "@camis/expr-ts";

export const conditionKey = (role: string, contentType: string, action: string): string =>
  `c__${role}__${contentType}__${action}`;

export const fieldRuleKey = (
  role: string,
  contentType: string,
  field: string,
  access: string,
): string => `f__${role}__${contentType}__${field}__${access}`;

export interface NamedCondition {
  key: string;
  expr: Expression;
}

export const ring1RuntimeFile = (): string => withMarker(tsRuntimeSource());

export const emitConditionsFile = (conditions: NamedCondition[]): string => {
  const body = conditions
    .map(
      (c) =>
        `export const ${c.key} = (data: Record<string, Value>): EvalResult => ${emitTs(c.expr)};`,
    )
    .join("\n");
  return withMarker(`import { r, type EvalResult, type Value } from "../ring1/runtime";

${body}
`);
};
