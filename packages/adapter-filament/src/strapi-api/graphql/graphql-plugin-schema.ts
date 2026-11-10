import {
  listArguments,
  PUBLICATION_ARGUMENTS,
  TIMESTAMPS,
  type Argument,
  type DefinitionSink,
  type Member,
} from "./graphql-sdl";

/**
 * The GraphQL types, queries and mutations Strapi's own plugins add to the content API: the
 * users-permissions plugin's sign-in, users and roles, the i18n plugin's locales and the upload
 * plugin's files. strapi-php's printed schema is the oracle, definition for definition, and
 * graphql-plugin-vectors.json, recorded from it, is the behaviour.
 */

/** A root field the runtime answers itself rather than through a content type's controller. */
export type PluginAction =
  | `files.${"find" | "findOne" | "connection" | "update" | "delete"}`
  | `locales.${"find" | "findOne" | "connection"}`
  | `users.${"find" | "findOne" | "connection" | "create" | "update" | "delete"}`
  | `roles.${"find" | "findOne" | "connection" | "create" | "update" | "delete"}`
  | `auth.${"me" | "login" | "register" | "forgotPassword" | "resetPassword" | "changePassword" | "emailConfirmation"}`;

export interface PluginApis {
  queries: Member[];
  mutations: Member[];
  fields: [field: string, action: PluginAction][];
}

export interface PluginApisInput {
  media: boolean;
  localized: boolean;
}

/** One attribute of a plugin's content type: a scalar, or a relation to another of its types. */
type Attribute = { name: string; type: string } | { name: string; target: string; many: boolean };

const USER: Attribute[] = [
  { name: "username", type: "String!" },
  { name: "email", type: "String!" },
  { name: "provider", type: "String" },
  { name: "confirmed", type: "Boolean" },
  { name: "blocked", type: "Boolean" },
  { name: "role", target: "UsersPermissionsRole", many: false },
];
const ROLE: Attribute[] = [
  { name: "name", type: "String!" },
  { name: "description", type: "String" },
  { name: "type", type: "String" },
  { name: "permissions", target: "UsersPermissionsPermission", many: true },
  { name: "users", target: "UsersPermissionsUser", many: true },
];
const PERMISSION: Attribute[] = [
  { name: "action", type: "String!" },
  { name: "role", target: "UsersPermissionsRole", many: false },
];
const LOCALE: Attribute[] = [
  { name: "name", type: "String" },
  { name: "code", type: "String" },
];

/** A plugin content type as Strapi's shadow CRUD prints it: its type and its filters. */
const contentType = (b: DefinitionSink, name: string, attributes: Attribute[]): void => {
  b.scalar("DateTime");
  b.pagination();
  const filters = `${name}FiltersInput`;
  b.need(name, () => ({
    kind: "type",
    name,
    fields: [
      { name: "documentId", type: "ID!" },
      ...attributes.flatMap((a): Member[] => {
        if ("type" in a) return [{ name: a.name, type: a.type }];
        if (!a.many) return [{ name: a.name, type: a.target }];
        const args = listArguments(`${a.target}FiltersInput`);
        return [
          { name: `${a.name}_connection`, args, type: b.relationCollection(a.target) },
          { name: a.name, args, type: `[${a.target}]!` },
        ];
      }),
      ...TIMESTAMPS.map((t) => ({ name: t, type: "DateTime" })),
    ],
  }));
  b.need(filters, () => ({
    kind: "input",
    name: filters,
    fields: [
      { name: "documentId", type: b.scalarFilter("ID") },
      ...attributes.map((a) => ({
        name: a.name,
        type: "type" in a ? b.scalarFilter(a.type.replace("!", "")) : `${a.target}FiltersInput`,
      })),
      ...TIMESTAMPS.map((t) => ({ name: t, type: b.scalarFilter("DateTime") })),
      { name: "and", type: `[${filters}]` },
      { name: "or", type: `[${filters}]` },
      { name: "not", type: filters },
    ],
  }));
};

const entityCollection = (b: DefinitionSink, name: string): string =>
  b.need(`${name}EntityResponseCollection`, () => ({
    kind: "type",
    name: `${name}EntityResponseCollection`,
    fields: [
      { name: "nodes", type: `[${name}!]!` },
      { name: "pageInfo", type: "Pagination!" },
    ],
  }));

/** findOne, find as a connection, and find: the shadow CRUD queries of a type. */
const shadowQueries = (
  b: DefinitionSink,
  type: string,
  single: string,
  plural: string,
): Member[] => {
  const filters = listArguments(`${type}FiltersInput`);
  return [
    {
      name: single,
      args: [{ name: "documentId", type: "ID!" }, ...PUBLICATION_ARGUMENTS],
      type,
    },
    {
      name: `${plural}_connection`,
      args: [...filters, ...PUBLICATION_ARGUMENTS],
      type: entityCollection(b, type),
    },
    { name: plural, args: [...filters, ...PUBLICATION_ARGUMENTS], type: `[${type}]!` },
  ];
};

const payload = (b: DefinitionSink, name: string, fields: Member[]): string =>
  b.need(name, () => ({ kind: "type", name, fields }));
const input = (b: DefinitionSink, name: string, fields: Member[]): string =>
  b.need(name, () => ({ kind: "input", name, fields }));

const id: Argument = { name: "id", type: "ID!" };
const strings = (...names: string[]): Argument[] =>
  names.map((name) => ({ name, type: "String!" }));

const usersPermissions = (b: DefinitionSink, apis: PluginApis): void => {
  contentType(b, "UsersPermissionsPermission", PERMISSION);
  contentType(b, "UsersPermissionsRole", ROLE);
  contentType(b, "UsersPermissionsUser", USER);
  apis.queries.push(
    ...shadowQueries(b, "UsersPermissionsRole", "usersPermissionsRole", "usersPermissionsRoles"),
    ...shadowQueries(b, "UsersPermissionsUser", "usersPermissionsUser", "usersPermissionsUsers"),
  );
  apis.fields.push(
    ["usersPermissionsRole", "roles.findOne"],
    ["usersPermissionsRoles_connection", "roles.connection"],
    ["usersPermissionsRoles", "roles.find"],
    ["usersPermissionsUser", "users.findOne"],
    ["usersPermissionsUsers_connection", "users.connection"],
    ["usersPermissionsUsers", "users.find"],
  );

  const meRole = payload(b, "UsersPermissionsMeRole", [
    { name: "id", type: "ID!" },
    { name: "name", type: "String!" },
    { name: "description", type: "String" },
    { name: "type", type: "String" },
  ]);
  const me = payload(b, "UsersPermissionsMe", [
    { name: "id", type: "ID!" },
    { name: "documentId", type: "ID!" },
    { name: "username", type: "String!" },
    { name: "email", type: "String" },
    { name: "confirmed", type: "Boolean" },
    { name: "blocked", type: "Boolean" },
    { name: "role", type: meRole },
  ]);
  apis.queries.push({ name: "me", type: me });
  apis.fields.push(["me", "auth.me"]);

  const roleInput = input(b, "UsersPermissionsRoleInput", [
    { name: "name", type: "String" },
    { name: "description", type: "String" },
    { name: "type", type: "String" },
    { name: "permissions", type: "[ID]" },
    { name: "users", type: "[ID]" },
    { name: "publishedAt", type: "DateTime" },
    { name: "locale", type: "String" },
  ]);
  const ok = [{ name: "ok", type: "Boolean!" }];
  const userInput = input(b, "UsersPermissionsUserInput", [
    { name: "username", type: "String" },
    { name: "email", type: "String" },
    { name: "provider", type: "String" },
    { name: "password", type: "String" },
    { name: "resetPasswordToken", type: "String" },
    { name: "confirmationToken", type: "String" },
    { name: "confirmed", type: "Boolean" },
    { name: "blocked", type: "Boolean" },
    { name: "role", type: "ID" },
    { name: "publishedAt", type: "DateTime" },
    { name: "locale", type: "String" },
  ]);
  const userResponse = `${payload(b, "UsersPermissionsUserEntityResponse", [
    { name: "data", type: "UsersPermissionsUser" },
  ])}!`;
  const roleData = { name: "data", type: `${roleInput}!` };
  const userData = { name: "data", type: `${userInput}!` };
  apis.mutations.push(
    {
      name: "createUsersPermissionsRole",
      description: "Create a new role",
      args: [roleData],
      type: payload(b, "UsersPermissionsCreateRolePayload", ok),
    },
    {
      name: "updateUsersPermissionsRole",
      description: "Update an existing role",
      args: [id, roleData],
      type: payload(b, "UsersPermissionsUpdateRolePayload", ok),
    },
    {
      name: "deleteUsersPermissionsRole",
      description: "Delete an existing role",
      args: [id],
      type: payload(b, "UsersPermissionsDeleteRolePayload", ok),
    },
    {
      name: "createUsersPermissionsUser",
      description: "Create a new user",
      args: [userData],
      type: userResponse,
    },
    {
      name: "updateUsersPermissionsUser",
      description: "Update an existing user",
      args: [id, userData],
      type: userResponse,
    },
    {
      name: "deleteUsersPermissionsUser",
      description: "Delete an existing user",
      args: [id],
      type: userResponse,
    },
  );
  apis.fields.push(
    ["createUsersPermissionsRole", "roles.create"],
    ["updateUsersPermissionsRole", "roles.update"],
    ["deleteUsersPermissionsRole", "roles.delete"],
    ["createUsersPermissionsUser", "users.create"],
    ["updateUsersPermissionsUser", "users.update"],
    ["deleteUsersPermissionsUser", "users.delete"],
  );

  const login = payload(b, "UsersPermissionsLoginPayload", [
    { name: "jwt", type: "String" },
    { name: "user", type: `${me}!` },
  ]);
  const loginInput = input(b, "UsersPermissionsLoginInput", [
    { name: "identifier", type: "String!" },
    { name: "password", type: "String!" },
    { name: "provider", type: "String!", default: '"local"' },
  ]);
  const registerInput = input(b, "UsersPermissionsRegisterInput", [
    { name: "username", type: "String!" },
    { name: "email", type: "String!" },
    { name: "password", type: "String!" },
  ]);
  const password = payload(b, "UsersPermissionsPasswordPayload", ok);
  apis.mutations.push(
    { name: "login", args: [{ name: "input", type: `${loginInput}!` }], type: `${login}!` },
    {
      name: "register",
      description: "Register a user",
      args: [{ name: "input", type: `${registerInput}!` }],
      type: `${login}!`,
    },
    {
      name: "forgotPassword",
      description: "Request a reset password token",
      args: strings("email"),
      type: password,
    },
    {
      name: "resetPassword",
      description: "Reset user password. Confirm with a code (resetToken from forgotPassword)",
      args: strings("password", "passwordConfirmation", "code"),
      type: login,
    },
    {
      name: "changePassword",
      description: "Change user password. Confirm with the current password.",
      args: strings("currentPassword", "password", "passwordConfirmation"),
      type: login,
    },
    {
      name: "emailConfirmation",
      description: "Confirm an email users email address",
      args: strings("confirmation"),
      type: login,
    },
  );
  apis.fields.push(
    ["login", "auth.login"],
    ["register", "auth.register"],
    ["forgotPassword", "auth.forgotPassword"],
    ["resetPassword", "auth.resetPassword"],
    ["changePassword", "auth.changePassword"],
    ["emailConfirmation", "auth.emailConfirmation"],
  );
};

const locales = (b: DefinitionSink, apis: PluginApis): void => {
  contentType(b, "I18NLocale", LOCALE);
  apis.queries.push(...shadowQueries(b, "I18NLocale", "i18NLocale", "i18NLocales"));
  apis.fields.push(
    ["i18NLocale", "locales.findOne"],
    ["i18NLocales_connection", "locales.connection"],
    ["i18NLocales", "locales.find"],
  );
};

/** The media library's files: UploadFile itself is defined with the content types it links. */
const files = (b: DefinitionSink, apis: PluginApis): void => {
  apis.queries.push(...shadowQueries(b, "UploadFile", "uploadFile", "uploadFiles"));
  const info = input(b, "FileInfoInput", [
    { name: "name", type: "String" },
    { name: "alternativeText", type: "String" },
    { name: "caption", type: "String" },
  ]);
  apis.mutations.push(
    { name: "updateUploadFile", args: [id, { name: "info", type: info }], type: "UploadFile!" },
    { name: "deleteUploadFile", args: [id], type: "UploadFile" },
  );
  apis.fields.push(
    ["uploadFile", "files.findOne"],
    ["uploadFiles_connection", "files.connection"],
    ["uploadFiles", "files.find"],
    ["updateUploadFile", "files.update"],
    ["deleteUploadFile", "files.delete"],
  );
};

export const definePluginApis = (b: DefinitionSink, options: PluginApisInput): PluginApis => {
  const apis: PluginApis = { queries: [], mutations: [], fields: [] };
  if (options.media) files(b, apis);
  if (options.localized) locales(b, apis);
  usersPermissions(b, apis);
  return apis;
};
