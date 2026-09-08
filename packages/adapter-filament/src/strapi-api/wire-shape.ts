import { expandComponents } from "@camis/adapter-kernel";
import type { ContentType, FieldType, IrDocument } from "@camis/ir-schema";
import { childTableEmit } from "../components";
import { filamentNames, snakeColumn } from "../names";
import { camelKey } from "./names";

export interface WireScalar {
  key: string[];
  column: string;
  type: FieldType;
}
export interface WireChild {
  key: string;
  relation: string;
  model: string;
  scalars: WireScalar[];
}
export interface WireShape {
  model: string;
  keyColumn: "id" | string;
  scalars: WireScalar[];
  children: WireChild[];
}

// `_fkNames` is accepted for signature stability with the controller emitter (Task 5+);
// relations are excluded by construction, so the current shape builder never reads it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const wireShape = (doc: IrDocument, ct: ContentType, _fkNames: string[]): WireShape => {
  const names = filamentNames(ct);
  const expansion = expandComponents(doc, ct);
  const top: WireScalar[] = ct.fields
    .filter((f) => f.type !== "relation" && f.type !== "component")
    .map((f) => ({ key: [camelKey(f.name)], column: snakeColumn(f.name), type: f.type }));
  const embedded: WireScalar[] = expansion.scalars.map((s) => ({
    key: s.path.map(camelKey),
    column: s.path.map(snakeColumn).join("_"),
    type: s.field.type,
  }));
  const children: WireChild[] = expansion.tables.map((t) => {
    const child = childTableEmit(ct, t);
    return {
      key: camelKey(t.path.join(".")),
      relation: child.relationName,
      model: child.model,
      scalars: t.scalars.map((s) => ({
        key: s.path.map(camelKey),
        column: s.path.map(snakeColumn).join("_"),
        type: s.field.type,
      })),
    };
  });
  const upsertBy = ct.options?.upsertBy;
  return {
    model: names.model,
    keyColumn: upsertBy !== undefined ? snakeColumn(upsertBy) : "id",
    scalars: [...top, ...embedded],
    children,
  };
};
