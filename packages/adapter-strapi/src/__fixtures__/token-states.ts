// ctx.state as Strapi 5.48 leaves it for a content API token: the auth middleware sets
// `{ strategy, credentials, ability }` (@strapi/core services/auth), the strategy is @strapi/admin's
// `content-api-token`, and `credentials` is the stored token, whose `type` is one of
// `full-access`, `read-only` or `custom` (only a custom token carries an ability).
export type TokenType = "full-access" | "read-only" | "custom";

export const tokenState = (type: TokenType) => ({
  isAuthenticated: true,
  auth: {
    strategy: { name: "content-api-token" },
    credentials: { id: 1, kind: "content-api", type },
    ...(type === "custom" ? { ability: {} } : {}),
  },
});
