import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";

const storeFile = (roles: string[]): string => {
  const users = roles
    .map(
      (role, i) =>
        `  { id: ${i + 1}, role: ${JSON.stringify(role)}, email: ${JSON.stringify(
          `${role.toLowerCase()}@example.com`,
        )}, password: "dev" },`,
    )
    .join("\n");
  // No marker: this is a protected, hand-editable seed file.
  return `// camis dev auth stub — REPLACE FOR PRODUCTION (real user store, hashing, secret from env).
export interface CamisUser {
  id: number;
  role: string;
  email: string;
}

const USERS: (CamisUser & { password: string })[] = [
${users}
];

export const jwtSecret = "dev-secret-change-me";

export const verifyCredentials = (email: string, password: string): CamisUser | null => {
  const u = USERS.find((x) => x.email === email && x.password === password);
  return u ? { id: u.id, role: u.role, email: u.email } : null;
};

export const getUser = (id: number): CamisUser | null => {
  const u = USERS.find((x) => x.id === id);
  return u ? { id: u.id, role: u.role, email: u.email } : null;
};
`;
};

const VERIFY = withMarker(`import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getUser, jwtSecret, type CamisUser } from "./store";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      camisUser?: CamisUser;
    }
  }
}

export const verify = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret) as { sub: number };
      const user = getUser(payload.sub);
      if (user) req.camisUser = user;
    } catch {
      /* invalid/expired token → treated as anonymous */
    }
  }
  next();
};
`);

const LOGIN = withMarker(`import { Router } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret, verifyCredentials } from "./store";

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  const user = verifyCredentials(String(email), String(password));
  if (!user) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "12h" });
  res.json({ token, user });
});
`);

export const authFiles = (roles: string[]): GeneratedFile[] => [
  { path: "src/auth/store.ts", content: storeFile(roles), mode: "seed" },
  { path: "src/auth/verify.ts", content: VERIFY },
  { path: "src/auth/login.ts", content: LOGIN },
];
