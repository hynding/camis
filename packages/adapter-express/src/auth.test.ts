import { describe, expect, it } from "vitest";
import { authFiles } from "./auth";

describe("authFiles", () => {
  const files = authFiles(["Editor", "Viewer"]);
  const byPath = (p: string) => files.find((f) => f.path === p)!;
  it("emits a protected (seed) store with one dev user per role", () => {
    const store = byPath("src/auth/store.ts");
    expect(store.mode).toBe("seed");
    expect(store.content).toContain('role: "Editor"');
    expect(store.content).toContain('role: "Viewer"');
    expect(store.content).not.toContain('export const jwtSecret = "dev-secret-change-me";');
    expect(store.content).not.toContain("@camis:generated");
  });
  // A secret in the seed file would ship to production unchanged: it comes from the environment,
  // and only a development server falls back to a fixed one.
  it("reads the JWT secret from CAMIS_JWT_SECRET and refuses to start in production without it", () => {
    const store = byPath("src/auth/store.ts").content;
    expect(store).toContain("const configured = process.env.CAMIS_JWT_SECRET;");
    expect(store).toContain(
      'throw new Error("CAMIS_JWT_SECRET must be set in production (and replace the dev users in src/auth/store.ts)");',
    );
  });
  // Strapi refuses a token that does not verify; it does not serve the caller as a guest.
  it("answers a token that does not verify with a 401", () => {
    const verify = byPath("src/auth/verify.ts").content;
    expect(verify).toContain('res.status(401).json({ error: "invalid or expired token" });');
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
