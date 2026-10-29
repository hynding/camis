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

const zonedDoc: IrDocument = normalize({
  version: 1,
  contentTypes: [
    {
      name: "Page",
      kind: "collection",
      fields: [{ type: "dynamicZone", name: "sections", components: ["Banner"] }],
    },
  ],
  components: [
    {
      name: "Banner",
      fields: [
        { type: "string", name: "title" },
        { type: "media", name: "picture" },
      ],
    },
  ],
});

const stampedDoc: IrDocument = normalize({
  version: 1,
  contentTypes: [
    { name: "Visit", kind: "collection", fields: [{ type: "timestamp", name: "seenAt" }] },
  ],
  components: [],
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
  // Strapi sends every attribute, null when it has no value; populate-vectors.expected.json,
  // recorded from strapi-php, keeps those nulls.
  it("sends a null attribute as null, as Strapi does, and never reads or writes relation FKs", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).not.toContain("omitNulls");
    expect(php).toContain(
      "public static function toWire(Note $m): array\n    {\n        return [\n",
    );
    // The foreign key is named only in the relation map, which StrapiRelations writes through.
    expect(php.slice(php.indexOf("public static function toWire"))).not.toContain("owner_id");
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
  it("stamps publishedAt on a type without draft and publish at its last write, as Strapi does", () => {
    const transaction = emitSerializer(shape("Transaction"));
    expect(transaction).toContain(
      "'publishedAt' => $m->updated_at?->toIso8601ZuluString('millisecond'),",
    );
    expect(transaction).toContain(
      "'publishedAt' => ['column' => 'updated_at', 'type' => 'dateTime'],",
    );
  });

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
  // A component with no value is null; one with a value sends its own nulls.
  it("uses self::nested for an embedded component so an all-null one is null, not []", () => {
    const transaction = emitSerializer(shape("Transaction"));
    expect(transaction).toContain("self::nested(");
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
  // Strapi sends a `timestamp` attribute as its epoch in milliseconds, as a string
  // ("1772359200000"), and takes either that or a date string on a write.
  it("serializes a timestamp as Strapi does, epoch milliseconds as a string, and reads one back", () => {
    const php = emitSerializer(wireShape(stampedDoc, stampedDoc.contentTypes[0]!, []));
    expect(php).toContain(
      "'seenAt' => $m->seen_at === null ? null : (string) $m->seen_at->getTimestampMs(),",
    );
    expect(php).toContain("'seen_at' => self::epoch(self::dig($data, ['seenAt'])),");
    expect(php).toContain("private static function epoch(mixed $value): mixed");
    expect(emitSerializer(shape("Note"))).not.toContain("function epoch");
  });
  // Strapi sends every component it stores as a row with that row's id.
  it("sends a repeatable component's items with their ids", () => {
    const php = emitSerializer(shape("ActivitySession"));
    expect(php).toMatch(
      /'quantities' => \$m->quantities->map\(fn \(\$c\) => \[\n\s+'id' => \$c->id,/,
    );
  });
  // A zone item's media, like its own components, waits for the zone's populate to name it.
  it("lists a zone member's media among the keys its populate names", () => {
    const php = emitSerializer(wireShape(zonedDoc, zonedDoc.contentTypes[0]!, []));
    expect(php).toContain("'components' => ['picture']");
  });
});
