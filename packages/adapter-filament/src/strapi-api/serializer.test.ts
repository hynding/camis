import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitSerializer } from "./serializer";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const shape = (name: string) =>
  wireShape(doc, doc.contentTypes.find((c) => c.name === name)!, ["owner_id"]);

const nestedDoc: IrDocument = normalize({
  version: 1,
  contentTypes: [
    {
      name: "Consumable",
      kind: "collection",
      fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "component", name: "facts", component: "Facts", repeatable: false },
      ],
    },
  ],
  components: [
    {
      name: "Facts",
      fields: [
        { type: "decimal", name: "calories" },
        { type: "component", name: "additional", component: "Nutrient", repeatable: true },
      ],
    },
    {
      name: "Nutrient",
      fields: [
        { type: "string", name: "slug" },
        { type: "decimal", name: "amount" },
      ],
    },
  ],
});

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
  // On the Strapi storage layout a `date` column carries no model cast (spec 17i) — Laravel's
  // would write `Y-m-d H:i:s` into a column Strapi fills with a bare `Y-m-d`. The attribute is
  // therefore already the string Strapi itself serves, and `?->toDateString()` on it would be a
  // fatal "call to a member function on string".
  it("passes a date straight through on the strapi storage layout, where it is uncast", () => {
    const php = emitSerializer(shape("Transaction"), "strapi");
    expect(php).toContain("'occurredOn' => $m->occurred_on,");
    expect(php).not.toContain("toDateString");
    // Datetimes still go through Carbon there: they keep the StrapiDateTime cast.
    expect(php).toContain("$m->created_at?->toIso8601ZuluString('millisecond')");
  });
  it("omits nulls via the shared helper and never emits relation FKs", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).toContain("self::omitNulls(");
    expect(php).not.toContain("owner_id");
  });

  // Strapi renders a datetime the way JavaScript does — three fractional digits, Zulu — while
  // Carbon's toJSON() emits six. The cross-backend run reads the same row through both apps, so
  // the difference is a wire divergence, not cosmetics.
  it("serializes a datetime with millisecond precision in UTC, as Strapi does", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).toContain("'occurredAt' => $m->occurred_at?->toIso8601ZuluString('millisecond')");
    expect(php).toContain("'createdAt' => $m->created_at?->toIso8601ZuluString('millisecond')");
    expect(php).toContain("'updatedAt' => $m->updated_at?->toIso8601ZuluString('millisecond')");
    expect(php).not.toContain("toJSON()");
  });

  // Strapi returns a biginteger as a string — a 64-bit value does not survive a JSON number — so
  // an int cast here would answer 1250 where Strapi answers "1250".
  it("serializes a bigInteger as a string and a plain integer as a number", () => {
    const php = emitSerializer(shape("Transaction"));
    expect(php).toContain(
      "'minor' => $m->amount_minor === null ? null : (string) $m->amount_minor",
    );
    expect(php).not.toContain("(int) $m->amount_minor");
  });
  it("fromWire only sets a child key when the wire payload mentions it (partial-update safe)", () => {
    const php = emitSerializer(shape("ActivitySession"));
    expect(php).toContain("$children = [];");
    expect(php).toContain("if (self::has($data, ['quantities'])) {");
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
  it("nests a nested repeatable under its parent on the wire and reads it back by path", () => {
    const php = emitSerializer(wireShape(nestedDoc, nestedDoc.contentTypes[0]!, []));
    expect(php).toContain("'facts' => self::nested([");
    expect(php).toContain("'additional' => $m->factsAdditional->map(");
    // Only the FIELDS map (the query runtime's lookup table) spells the path with a dot.
    expect(php.slice(php.indexOf("function toWire"))).not.toContain("'facts.additional'");
    expect(php).toContain("if (self::has($data, ['facts', 'additional'])) {");
    expect(php).toContain("self::dig($data, ['facts', 'additional'])");
  });
  it("ConsumableNested serializer golden (repeatable nested under a non-repeatable branch, PSR-12 indentation)", async () => {
    await expect(
      emitSerializer(wireShape(nestedDoc, nestedDoc.contentTypes[0]!, [])),
    ).toMatchFileSnapshot("./__golden__/strapi-api/ConsumableNestedSerializer.php");
  });
});
