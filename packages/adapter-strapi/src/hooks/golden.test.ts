import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { hooksDoc } from "../__fixtures__/hooks";

describe("strapi hooks golden", () => {
  const result = strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("contract golden", async () => {
    await expect(c("src/hooks/contracts/transform-title.contract.ts")).toMatchFileSnapshot(
      "./__golden__/transform-title.contract.ts.txt",
    );
  });
  it("stub golden (seed mode)", async () => {
    const stub = result.files.find((f) => f.path === "src/hooks/transform-title.ts")!;
    expect(stub.mode).toBe("seed");
    await expect(stub.content).toMatchFileSnapshot("./__golden__/transform-title.stub.ts.txt");
  });
  it("lifecycle golden", async () => {
    await expect(c("src/api/article/content-types/article/lifecycles.ts")).toMatchFileSnapshot(
      "./__golden__/article.lifecycles.ts.txt",
    );
  });
  it("idempotent", () => {
    expect(
      strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" }),
    ).toEqual(result);
  });
});
