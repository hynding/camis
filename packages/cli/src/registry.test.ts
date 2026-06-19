import { describe, expect, it } from "vitest";
import { adapterFor } from "./registry";

describe("adapterFor", () => {
  it("maps each target name to an adapter with the matching .target", () => {
    expect(adapterFor({ target: "express", out: "/o" }).target).toBe("express");
    expect(adapterFor({ target: "strapi", out: "/o" }).target).toBe("strapi");
    expect(adapterFor({ target: "filament", out: "/o" }).target).toBe("filament");
  });
  it("honors the express dialect without throwing", () => {
    expect(adapterFor({ target: "express", out: "/o", dialect: "pgsql" }).target).toBe("express");
  });
});
