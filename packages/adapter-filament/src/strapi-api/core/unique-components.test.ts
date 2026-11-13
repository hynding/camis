import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { uniqueComponentsBundle } from "../__fixtures__/unique-components";

// Strapi's unique check inside components: against the other entries' rows wherever the value is
// stored, and against the entry's own items where Strapi compares them.
const result = filamentAdapter.generate(uniqueComponentsBundle, {
  projectName: "fest",
  apiStyle: "strapi",
});
const rules = result.files.find(
  (f) => f.path === "app/Http/Controllers/Api/Generated/EventApiController.php",
)!.content;
const unique = (relation: string | undefined, column: string): string =>
  `'code' => ['type' => 'string', 'unique' => [${relation === undefined ? "" : `'relation' => '${relation}', `}'column' => '${column}']]`;

describe("unique fields inside components", () => {
  it("checks an embedded component's against the entry's own column", () => {
    expect(rules).toContain(unique(undefined, "badge_code"));
  });

  it("checks a repeatable's items, what they embed and a repeatable inside them through the item rows", () => {
    expect(rules).toMatch(
      /'slots' => \[[\s\S]*?'code' => \['type' => 'string', 'unique' => \['relation' => '\w+', 'column' => 'badge_code'\]\]/,
    );
    expect(rules).toMatch(
      /'seats' => \[[\s\S]*?'unique' => \['relation' => '\w+\.\w+', 'column' => 'code'\]/,
    );
  });

  it("checks a repeatable inside an embedded component through its own rows", () => {
    expect(rules).toMatch(
      /'passes' => \[[\s\S]*?'unique' => \['relation' => '\w+', 'column' => 'code'\]/,
    );
  });

  it("checks a dynamic zone component's own field through its member's rows, and reports one below it", () => {
    expect(rules).toMatch(
      /'blocks' => \[[\s\S]*?'shared\.badge' => \[\s*'code' => \['type' => 'string', 'unique' => \['relation' => '\w+', 'column' => 'code'\]\]/,
    );
    expect(
      result.gaps.gaps
        .filter((g) => g.feature === "uniqueInComponent")
        .map((g) => g.location.field),
    ).toEqual(["blocks.badge.code", "blocks.seats.code"]);
  });
});
