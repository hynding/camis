import { describe, expect, it } from "vitest";
import { authFiles } from "./auth";

describe("authFiles", () => {
  const files = authFiles(["Editor", "Viewer"]);
  const byPath = (p: string) => files.find((f) => f.path === p)!;
  it("emits a protected (seed) store with one dev user per role and a fixed secret", () => {
    const store = byPath("src/auth/store.ts");
    expect(store.mode).toBe("seed");
    expect(store.content).toContain('role: "Editor"');
    expect(store.content).toContain('role: "Viewer"');
    expect(store.content).toContain('export const jwtSecret = "dev-secret-change-me";');
    expect(store.content).not.toContain("@camis:generated");
  });
  it("emits overwrite verify middleware that hydrates the user from the store", () => {
    const verify = byPath("src/auth/verify.ts");
    expect(verify.mode ?? "overwrite").toBe("overwrite");
    expect(verify.content).toContain("getUser(payload.sub)");
    expect(verify.content).toContain("req.camisUser");
    expect(verify.content).toContain("@camis:generated");
  });
  it("emits an overwrite login route that signs a JWT", () => {
    expect(byPath("src/auth/login.ts").content).toContain('authRouter.post("/login"');
  });
});
