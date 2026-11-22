import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";
import { decimalsBundle } from "./__fixtures__/decimals";
import { contentManagerMcpTools } from "./strapi-api/content-manager/mcp-tools";
import { strapiApiBundle } from "./strapi-api/__fixtures__/strapi-api";

const generate = (
  apiStyle: "laravel" | "strapi",
  storageLayout: "laravel" | "strapi" = "laravel",
) => filamentAdapter.generate(decimalsBundle, { projectName: "ledger", apiStyle, storageLayout });
const contentOf = (result: ReturnType<typeof generate>) => (path: string) =>
  result.files.find((f) => f.path === path)?.content ?? "";
const decimalGaps = (result: ReturnType<typeof generate>) =>
  result.gaps.gaps.filter((g) => g.feature === "decimalPrecision");

describe("decimals stating their digits (issue #104)", () => {
  for (const apiStyle of ["laravel", "strapi"] as const) {
    const content = contentOf(generate(apiStyle));
    it(`migrates and casts each decimal with its own digits on the ${apiStyle} API style`, async () => {
      await expect(
        content("database/migrations/0001_01_02_000001_create_ledgers_table.php"),
      ).toMatchFileSnapshot(`./__golden__/decimals/${apiStyle}/create_ledgers_table.php`);
      await expect(
        content("database/migrations/0001_01_02_000002_create_ledgers_entries_table.php"),
      ).toMatchFileSnapshot(`./__golden__/decimals/${apiStyle}/create_ledgers_entries_table.php`);
      await expect(content("app/Models/Ledger.php")).toMatchFileSnapshot(
        `./__golden__/decimals/${apiStyle}/Ledger.model.php`,
      );
      await expect(content("app/Models/LedgerEntries.php")).toMatchFileSnapshot(
        `./__golden__/decimals/${apiStyle}/LedgerEntries.model.php`,
      );
    });
  }

  it("regenerates them byte for byte", () => {
    expect(generate("strapi")).toEqual(generate("strapi"));
    expect(generate("laravel")).toEqual(generate("laravel"));
  });

  it("reports nothing on the Laravel API style, which neither filters nor sorts", () => {
    expect(decimalGaps(generate("laravel"))).toEqual([]);
  });

  // PDO SQLite reads a decimal column as a PHP float, which becomes a string of 14 digits.
  it("reports, located, that the Strapi API style compares a decimal beyond a PHP float as text on SQLite in an ordering filter, a sort or an admin list filter", () => {
    expect(decimalGaps(generate("strapi"))).toEqual([
      {
        feature: "decimalPrecision",
        location: { contentType: "Ledger", field: "balance" },
        severity: "downgrade",
        message:
          "\"balance\" keeps its 20 digits as text on SQLite, where a filter on it finds equal values exactly but compares text, not numbers, in an ordering comparison ($lt, $lte, $gt, $gte, $between) or a sort; a JSON number sent for it is read as a double first, so an exact value is sent as a string; the admin list's number filters compare it through a PHP float, as text on SQLite; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to 15 significant digits",
      },
      {
        feature: "decimalPrecision",
        location: { contentType: "Ledger", field: "share" },
        severity: "downgrade",
        message:
          "\"share\" keeps its 15 digits as text on SQLite, where a filter on it finds equal values exactly but compares text, not numbers, in an ordering comparison ($lt, $lte, $gt, $gte, $between) or a sort; a JSON number sent for it is read as a double first, so an exact value is sent as a string; the admin list's number filters compare it through a PHP float, as text on SQLite; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to 15 significant digits",
      },
      {
        feature: "decimalPrecision",
        location: { component: "Limit", field: "ceiling" },
        severity: "downgrade",
        message:
          "\"ceiling\" keeps its 18 digits as text on SQLite, where a filter on it finds equal values exactly but compares text, not numbers, in an ordering comparison ($lt, $lte, $gt, $gte, $between) or a sort; a JSON number sent for it is read as a double first, so an exact value is sent as a string; the admin list's number filters compare it through a PHP float, as text on SQLite; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to 15 significant digits",
      },
      {
        feature: "decimalPrecision",
        location: { component: "Entry", field: "amount" },
        severity: "downgrade",
        message:
          "\"amount\" keeps its 20 digits as text on SQLite, where a filter on it finds equal values exactly but compares text, not numbers, in an ordering comparison ($lt, $lte, $gt, $gte, $between) or a sort; a JSON number sent for it is read as a double first, so an exact value is sent as a string; the admin list's number filters compare it through a PHP float, as text on SQLite; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to 15 significant digits",
      },
    ]);
  });

  it("reports that on Strapi's storage layout SQLite keeps Strapi's column as a double", () => {
    expect(decimalGaps(generate("strapi", "strapi"))[0]).toEqual({
      feature: "decimalPrecision",
      location: { contentType: "Ledger", field: "balance" },
      severity: "downgrade",
      message:
        "\"balance\" keeps 20 digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double that PHP reads back as a float: on SQLite only 14 significant digits are kept",
    });
  });

  it("reports nothing where no decimal states more digits than a double keeps", () => {
    const result = filamentAdapter.generate(blog, { projectName: "blog", apiStyle: "strapi" });
    expect(result.gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([]);
  });

  // SQLite's text column takes any string: each API keeps a value as MySQL and PostgreSQL do.
  it("writes a decimal stating its digits at its scale on the Laravel API style, refusing one that is not a decimal that fits with Laravel's 422", async () => {
    await expect(
      contentOf(generate("laravel"))("app/Http/Controllers/Api/LedgerApiController.php"),
    ).toMatchFileSnapshot("./__golden__/decimals/laravel/LedgerApiController.php");
  });

  it("emits DecimalDigits, its Eloquent cast and its form rule, which every write of a decimal stating its digits goes through, only for a project with one", () => {
    const runtime = {
      "app/Support/DecimalDigits.php": "final class DecimalDigits",
      "app/Casts/DecimalDigitsCast.php": "final class DecimalDigitsCast implements CastsAttributes",
      "app/Rules/DecimalDigitsRule.php": "final class DecimalDigitsRule implements ValidationRule",
    };
    for (const [path, declaration] of Object.entries(runtime)) {
      for (const result of [
        generate("laravel"),
        generate("strapi"),
        generate("strapi", "strapi"),
      ]) {
        expect(contentOf(result)(path)).toContain(declaration);
      }
    }
    const blogFiles = filamentAdapter.generate(blog, { projectName: "blog", apiStyle: "strapi" });
    expect(blogFiles.files.filter((f) => f.path in runtime)).toEqual([]);
  });

  // Filament's ->numeric() makes the state a PHP float, which keeps 14 significant digits.
  for (const apiStyle of ["laravel", "strapi"] as const) {
    it(`edits each decimal stating its digits in the admin as text its digits rule refuses on the ${apiStyle} API style`, async () => {
      await expect(
        contentOf(generate(apiStyle))("app/Filament/Resources/Ledgers/Schemas/LedgerForm.php"),
      ).toMatchFileSnapshot(`./__golden__/decimals/${apiStyle}/LedgerForm.php`);
    });
  }

  it("searches the admin's list by a decimal stating its digits as its filters compare it", async () => {
    await expect(
      contentOf(generate("strapi"))("app/Filament/Resources/Ledgers/Schemas/LedgersTable.php"),
    ).toMatchFileSnapshot("./__golden__/decimals/strapi/LedgersTable.php");
  });

  // The import writes rows with the query builder, past every model's cast.
  it("imports a decimal stating its digits from an archive as every write keeps it, stopping at one that does not fit", () => {
    const content = contentOf(generate("strapi"));
    const map = content("app/Support/StrapiTransferMap.php");
    expect(map).toContain(
      "'balance' => [\n                    'column' => 'balance',\n                    'type' => 'decimal',\n                    'digits' => [20, 6],\n                ],",
    );
    expect(map).toContain(
      "'fee' => [\n                    'column' => 'fee',\n                    'type' => 'decimal',\n                ],",
    );
    const importer = content("app/Support/StrapiImport.php");
    expect(importer.match(/= self::digits\(self::value\(/g)).toHaveLength(3);
    expect(importer).toContain(
      "private static function digits(mixed $value, array $attribute, string $column): mixed",
    );
    expect(importer).toContain(
      `?? throw new \\RuntimeException("{$column} takes a decimal of at most {$precision} digits, {$scale} of them after the point, not " . var_export($value, true));`,
    );
    // Every other project imports exactly as before.
    const blogImporter =
      filamentAdapter
        .generate(blog, { projectName: "blog", apiStyle: "strapi" })
        .files.find((f) => f.path === "app/Support/StrapiImport.php")?.content ?? "";
    expect(blogImporter).not.toContain("self::digits(");
    expect(blogImporter).toContain(
      "$row[$attribute['column']] = self::value($value, $attribute['type'], $model->getDateFormat());",
    );
  });

  // A float holds 15 digits; MySQL compares a DECIMAL with a string as two doubles.
  it("filters a decimal stating its digits by its exact value, never through a float nor rounded, and every other project as before", () => {
    const query = contentOf(generate("strapi"))("app/Support/StrapiQuery.php");
    expect(query).toContain(
      `self::attribute($query, $query->qualifyColumn($field['column']), (isset($field['scale']) ? "decimal:{$field['precision']},{$field['scale']}" : $field['type']), $value, self::join($at, $wirePath));`,
    );
    // A value or a list without an operator is compared as by $eq or $in.
    expect(query).toContain(
      "if (str_starts_with($type, 'decimal:') && $value !== null && (! is_array($value) || array_is_list($value))) {\n            self::operator($query, $column, $type, is_array($value) ? '$in' : '$eq', $value, $wirePath);",
    );
    expect(query).toContain(
      "if (DecimalDigits::where($query, $column, $operator, $value, $precision, $scale)) {",
    );
    expect(query).not.toContain("DecimalDigits::filter");
    expect(query).toContain("            default => $value,\n");
    const blogQuery =
      filamentAdapter
        .generate(blog, { projectName: "blog", apiStyle: "strapi" })
        .files.find((f) => f.path === "app/Support/StrapiQuery.php")?.content ?? "";
    expect(blogQuery).not.toContain("DecimalDigits");
    expect(blogQuery).toContain(
      "self::attribute($query, $query->qualifyColumn($field['column']), $field['type'], $value, self::join($at, $wirePath));",
    );
  });

  describe("on the Strapi API style's wire", () => {
    const strapi = filamentAdapter.generate(decimalsBundle, {
      projectName: "ledger",
      apiStyle: "strapi",
      graphql: true,
      documentation: true,
    });
    const content = contentOf(strapi);

    // A JSON number holding more digits than a double keeps is rounded by every JavaScript client.
    it("answers a decimal beyond a PHP float as a string and the others as numbers, writes each stating its digits at its scale or refuses it, and gives the filters its scale", async () => {
      await expect(content("app/Http/Serializers/LedgerSerializer.php")).toMatchFileSnapshot(
        "./__golden__/decimals/strapi/LedgerSerializer.php",
      );
    });

    // StrapiValidator names a field in an item by its index: ['entries', '1', 'amount'].
    it("names a refused decimal in a repeatable's item or a zone's by its full path, its index included, and every other zone as before", () => {
      const serializer = content("app/Http/Serializers/LedgerSerializer.php");
      expect(serializer).toContain("['entries', (string) $i, 'amount']");
      expect(serializer).toContain(
        "fn (string $uid, array $item, int $position) => match ($uid) {",
      );
      expect(serializer).toContain("['lines', (string) $position, 'ceiling']");
      expect(content("app/Support/StrapiZones.php")).toContain(
        "array_filter($columns($uid, $item, $position), fn ($v) => $v !== null);",
      );
      const other = filamentAdapter.generate(strapiApiBundle, {
        projectName: "api",
        apiStyle: "strapi",
      });
      const zones = other.files.find((f) => f.path === "app/Support/StrapiZones.php")?.content;
      expect(zones).toContain("array_filter($columns($uid, $item), fn ($v) => $v !== null);");
      expect(other.files.map((f) => f.content).join("\n")).not.toContain("int $position) => match");
    });

    it("types a decimal beyond a double as a String over GraphQL, filtered as one", () => {
      const sdl = content("graphql/schema.graphql");
      const typeOf = (name: string, kind: "type" | "input"): string[] =>
        (new RegExp(`^${kind} ${name} \\{\\n([^}]*)\\}`, "m").exec(sdl)?.[1] ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^(balance|rate|share|units|fee|ceiling|amount):/.test(line));
      expect(typeOf("Ledger", "type")).toEqual([
        "balance: String",
        "rate: Float",
        "share: String",
        "units: Float",
        "fee: Float",
      ]);
      expect(typeOf("LedgerInput", "input")).toEqual([
        "balance: String",
        "rate: Float",
        "share: String",
        "units: Float",
        "fee: Float",
      ]);
      expect(typeOf("LedgerFiltersInput", "input")).toEqual([
        "balance: StringFilterInput",
        "rate: FloatFilterInput",
        "share: StringFilterInput",
        "units: FloatFilterInput",
        "fee: FloatFilterInput",
      ]);
      expect(typeOf("ComponentSharedLimit", "type")).toEqual(["ceiling: String"]);
      expect(typeOf("ComponentSharedEntryInput", "input")).toEqual(["amount: String"]);
    });

    it("documents a decimal beyond a double as a string answered, and a string or a number taken", () => {
      const document = JSON.parse(content("public/documentation/openapi.json")) as {
        paths: Record<string, Record<string, unknown>>;
        components: { schemas: Record<string, { properties: Record<string, unknown> }> };
      };
      const post = document.paths["/ledgers"]!.post as {
        requestBody: { content: Record<string, { schema: DataSchema }> };
        responses: Record<string, { content: Record<string, { schema: DataSchema }> }>;
      };
      interface DataSchema {
        properties: { data: { properties: Record<string, unknown> } };
      }
      const taken = post.requestBody.content["application/json"]!.schema.properties.data.properties;
      const answered =
        post.responses["200"]!.content["application/json"]!.schema.properties.data.properties;
      expect(answered.balance).toEqual({ description: "A decimal field", type: "string" });
      expect(taken.balance).toEqual({
        description: "A decimal field",
        anyOf: [{ type: "string" }, { type: "number" }],
      });
      expect(answered.rate).toEqual({ description: "A decimal field", type: "number" });
      expect(taken.rate).toEqual({ description: "A decimal field", type: "number" });
      expect(answered.share).toEqual({ description: "A decimal field", type: "string" });
      expect(answered.units).toEqual({ description: "A decimal field", type: "number" });
      expect(document.components.schemas.SharedLimitEntry!.properties.ceiling).toEqual({
        description: "A decimal field",
        type: "string",
      });
    });

    it("lets the content-manager's MCP tools take a decimal beyond a double as a string", () => {
      const create = contentManagerMcpTools(decimalsBundle.document).find(
        (tool) => tool.name === "create_ledger",
      );
      const data = (
        create?.inputSchema as { properties: { data: { properties: Record<string, unknown> } } }
      ).properties.data.properties;
      expect(data.balance).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
      expect(data.rate).toEqual({ type: "number" });
      expect(data.share).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
      expect(data.units).toEqual({ type: "number" });
    });

    it("lets the content-manager's MCP tools filter a decimal beyond a PHP float by strings or numbers, alone or in a list", () => {
      const list = contentManagerMcpTools(decimalsBundle.document).find(
        (tool) => tool.name === "list_ledger",
      );
      const definitions = Object.values(
        (list?.inputSchema as { $defs: Record<string, { properties?: Record<string, unknown> }> })
          .$defs,
      );
      const balance = definitions.find((d) => d.properties?.balance !== undefined)?.properties
        ?.balance as { anyOf: [unknown, { properties: Record<string, unknown> }] };
      const either = [{ type: "string" }, { type: "number" }];
      const value = { anyOf: [...either, { type: "array", items: { anyOf: either } }] };
      expect(balance.anyOf[0]).toEqual(value);
      expect(balance.anyOf[1].properties.$in).toEqual(value);
      expect(balance.anyOf[1].properties.$notIn).toEqual(value);
    });
  });
});
