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
  // Strapi renders a `date` attribute as YYYY-MM-DD; toJSON() would send a full ISO datetime with
  // a fabricated midnight-UTC time component that no client asked for.
  it("serializes a date field as YYYY-MM-DD, not a full ISO datetime", () => {
    const php = emitSerializer(shape("Transaction"));
    expect(php).toContain("'occurredOn' => $m->occurred_on?->toDateString()");
    expect(php).not.toContain("$m->occurred_on?->toJSON()");
  });
  it("omits nulls via the shared helper and never emits relation FKs", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).toContain("self::omitNulls(");
    expect(php).not.toContain("owner_id");
    expect(php).toContain("'occurredAt' => $m->occurred_at?->toJSON()");
    expect(php).toContain("'createdAt' => $m->created_at?->toJSON()");
  });
  it("fromWire only sets a child key when the wire payload mentions it (partial-update safe)", () => {
    const php = emitSerializer(shape("ActivitySession"));
    expect(php).toContain("$children = [];");
    expect(php).toContain("if (array_key_exists('quantities', $data)) {");
    expect(php).toContain("$children['quantities'] = array_map(");
  });
  it("uses self::nested for component/child branches so an all-null branch is omitted, not []", () => {
    const transaction = emitSerializer(shape("Transaction"));
    expect(transaction).toContain("self::nested(");
    const activitySession = emitSerializer(shape("ActivitySession"));
    expect(activitySession).toContain("->filter(fn ($r) => $r !== null)->values()->all()");
  });
  it("emits a clean empty $children array and an empty syncChildren body with no children", () => {
    const php = emitSerializer(shape("Transaction"));
    expect(php).toContain("$children = [];\n");
    expect(php).toContain(
      "public static function syncChildren(Transaction $m, array $children): void\n    {\n    }\n",
    );
  });
});
