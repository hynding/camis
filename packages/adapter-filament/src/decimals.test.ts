import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";
import { decimalsBundle } from "./__fixtures__/decimals";
import { contentManagerMcpTools } from "./strapi-api/content-manager/mcp-tools";

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

  it("reports, located, that the Strapi API style filters and sorts a decimal beyond a double as text on SQLite", () => {
    expect(decimalGaps(generate("strapi"))).toEqual([
      {
        feature: "decimalPrecision",
        location: { contentType: "Ledger", field: "balance" },
        severity: "downgrade",
        message:
          '"balance" keeps its 20 digits as text on SQLite, where a filter or a sort on it compares text, not numbers; a data-transfer archive carries it as a number, as Strapi\'s archives do, rounded to 15 significant digits',
      },
      {
        feature: "decimalPrecision",
        location: { component: "Limit", field: "ceiling" },
        severity: "downgrade",
        message:
          '"ceiling" keeps its 18 digits as text on SQLite, where a filter or a sort on it compares text, not numbers; a data-transfer archive carries it as a number, as Strapi\'s archives do, rounded to 15 significant digits',
      },
      {
        feature: "decimalPrecision",
        location: { component: "Entry", field: "amount" },
        severity: "downgrade",
        message:
          '"amount" keeps its 20 digits as text on SQLite, where a filter or a sort on it compares text, not numbers; a data-transfer archive carries it as a number, as Strapi\'s archives do, rounded to 15 significant digits',
      },
    ]);
  });

  it("reports that on Strapi's storage layout SQLite keeps Strapi's column as a double", () => {
    expect(decimalGaps(generate("strapi", "strapi"))[0]).toEqual({
      feature: "decimalPrecision",
      location: { contentType: "Ledger", field: "balance" },
      severity: "downgrade",
      message:
        "\"balance\" keeps 20 digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double: on SQLite only 15 significant digits are kept",
    });
  });

  it("reports nothing where no decimal states more digits than a double keeps", () => {
    const result = filamentAdapter.generate(blog, { projectName: "blog", apiStyle: "strapi" });
    expect(result.gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([]);
  });

  // PHP writes a float as a string of 14 significant digits, which is how PDO binds one.
  it("takes a JSON number for a decimal stating its digits as its shortest digits on the Laravel API style", async () => {
    await expect(
      contentOf(generate("laravel"))("app/Http/Controllers/Api/LedgerApiController.php"),
    ).toMatchFileSnapshot("./__golden__/decimals/laravel/LedgerApiController.php");
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
    it("answers a decimal beyond a double as a string, as its cast reads it, and the others as numbers, taking a JSON number as its shortest digits", async () => {
      await expect(content("app/Http/Serializers/LedgerSerializer.php")).toMatchFileSnapshot(
        "./__golden__/decimals/strapi/LedgerSerializer.php",
      );
    });

    it("types a decimal beyond a double as a String over GraphQL, filtered as one", () => {
      const sdl = content("graphql/schema.graphql");
      const typeOf = (name: string, kind: "type" | "input"): string[] =>
        (new RegExp(`^${kind} ${name} \\{\\n([^}]*)\\}`, "m").exec(sdl)?.[1] ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^(balance|rate|fee|ceiling|amount):/.test(line));
      expect(typeOf("Ledger", "type")).toEqual(["balance: String", "rate: Float", "fee: Float"]);
      expect(typeOf("LedgerInput", "input")).toEqual([
        "balance: String",
        "rate: Float",
        "fee: Float",
      ]);
      expect(typeOf("LedgerFiltersInput", "input")).toEqual([
        "balance: StringFilterInput",
        "rate: FloatFilterInput",
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
    });
  });
});
