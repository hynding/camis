#!/usr/bin/env node
// A stand-in identity provider for the OAuth vectors, served over HTTPS so that strapi-php and the
// generated app reach it as they would a real one: Keycloak's and CAS's endpoints (both take the
// provider's host from its subdomain setting) and Cognito's, with its JWKS. The authorization
// code names the account whose profile the provider hands back.
//
// usage: fake-oauth-provider.mjs --cert F --key F [--port 9443]
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    cert: { type: "string" },
    key: { type: "string" },
    port: { type: "string", default: "9443" },
  },
});
if (values.cert === undefined || values.key === undefined) {
  console.error("usage: fake-oauth-provider.mjs --cert F --key F [--port 9443]");
  process.exit(2);
}

const CLIENT = { id: "camis", secret: "s3cret" };

// Each provider's profile endpoint answers in its own shape.
const PEOPLE = {
  alice: { username: "alice", email: "Alice@Example.test", verified: true },
  bob: { username: "bob", email: "bob@example.test", verified: false },
  carol: { username: "carol-sso", email: "carol@example.test", verified: true },
  dave: { username: "dave", email: "dave@example.test", verified: true },
  ghost: { username: "ghost", verified: true },
  erin: { username: "erin", email: "erin@example.test", verified: true },
  fran: { username: "fran", email: "fran@example.test", verified: true },
};
const keycloakProfile = (p) => ({
  sub: p.username,
  preferred_username: p.username,
  ...(p.email === undefined ? {} : { email: p.email }),
  email_verified: p.verified,
});
const casProfile = (p) => ({
  id: p.username,
  attributes: { strapiemail: p.email, email_verified: p.verified },
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "fake-key";
const base64url = (data) => Buffer.from(data).toString("base64url");
const idToken = (p) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(
    JSON.stringify({
      sub: p.username,
      "cognito:username": p.username,
      email: p.email,
      email_verified: p.verified,
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
};

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });

// The code a token was issued for, from its bearer header.
const personOf = (req) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  return token.startsWith("token-") ? PEOPLE[token.slice("token-".length)] : undefined;
};

const exchange = async (req, res, provider) => {
  const form = await readBody(req);
  const code = form.get("code") ?? "";
  if (
    form.get("grant_type") !== "authorization_code" ||
    form.get("client_id") !== CLIENT.id ||
    form.get("client_secret") !== CLIENT.secret ||
    !(form.get("redirect_uri") ?? "").endsWith(`/api/connect/${provider}/callback`)
  )
    return send(res, 400, { error: "invalid_request", error_description: "Bad token request" });
  const person = PEOPLE[code];
  if (person === undefined)
    return send(res, 400, { error: "invalid_grant", error_description: "Code is invalid" });
  return send(res, 200, {
    access_token: `token-${code}`,
    token_type: "Bearer",
    expires_in: 300,
    ...(provider === "cognito" ? { id_token: idToken(person) } : {}),
  });
};

const ROUTES = {
  "POST /realms/test/protocol/openid-connect/token": (req, res) => exchange(req, res, "keycloak"),
  "GET /realms/test/protocol/openid-connect/userinfo": (req, res) => {
    const person = personOf(req);
    return person === undefined
      ? send(res, 401, { error: "invalid_token" })
      : send(res, 200, keycloakProfile(person));
  },
  "POST /cas/oidc/token": (req, res) => exchange(req, res, "cas"),
  "GET /cas/oidc/profile": (req, res) => {
    const person = personOf(req);
    return person === undefined
      ? send(res, 401, { error: "invalid_token" })
      : send(res, 200, casProfile(person));
  },
  "POST /cognito/oauth2/token": (req, res) => exchange(req, res, "cognito"),
  "GET /cognito/jwks": (_req, res) =>
    send(res, 200, {
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }],
    }),
};

createServer({ cert: readFileSync(values.cert), key: readFileSync(values.key) }, (req, res) => {
  const route = ROUTES[`${req.method} ${new URL(req.url, "https://localhost").pathname}`];
  if (route === undefined) return send(res, 404, { error: "not_found" });
  return route(req, res);
}).listen(Number(values.port), "127.0.0.1", () =>
  console.log(`fake OAuth provider on https://127.0.0.1:${values.port}`),
);
