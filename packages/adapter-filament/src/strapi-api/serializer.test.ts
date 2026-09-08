import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitSerializer } from "./serializer";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const shape = (name: string) =>
  wireShape(doc, doc.contentTypes.find((c) => c.name === name)!, ["owner_id"]);

describe("emitSerializer", () => {
  it("Transaction serializer golden (embedded component + decimal + bigInteger)", async () => {
    await expect(emitSerializer(shape("Transaction"))).toMatchFileSnapshot(
      "./__golden__/strapi-api/TransactionSerializer.php",
    );
  });
  it("ActivitySession serializer golden (repeatable child)", async () => {
    await expect(emitSerializer(shape("ActivitySession"))).toMatchFileSnapshot(
      "./__golden__/strapi-api/ActivitySessionSerializer.php",
    );
  });
  it("omits nulls via the shared helper and never emits relation FKs", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).toContain("self::omitNulls(");
    expect(php).not.toContain("owner_id");
    expect(php).toContain("'occurredAt' => $m->occurred_at?->toJSON()");
    expect(php).toContain("'createdAt' => $m->created_at?->toJSON()");
  });
});
