import {
  isEnvReference,
  type AccountSettings,
  type CorsSettings,
  type PageSizes,
  type RestSettings,
  type EmailSettings,
  type ErrorReportingSettings,
  type FileStorage,
  type MailTransport,
  type DeploymentSettings,
  type Setting,
  type UploadSettings,
} from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";

type Options = Record<string, unknown>;

const object = (value: unknown): Options =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Options) : {};

const setting = (value: unknown): Setting | undefined =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  isEnvReference(value)
    ? value
    : undefined;

/** The keys whose value is a setting, under the names given; undefined ones left out. */
const settings = <K extends string>(entries: [K, unknown][]): Partial<Record<K, Setting>> =>
  Object.fromEntries(
    entries.flatMap(([key, value]) => {
      const s = setting(value);
      return s === undefined ? [] : [[key, s]];
    }),
  ) as Partial<Record<K, Setting>>;

const gap = (feature: string, message: string): CapabilityGap => ({
  feature,
  location: {},
  severity: "downgrade",
  message,
});

const s3Storage = (options: Options, gaps: CapabilityGap[]): FileStorage => {
  // Strapi 5 nests the AWS client's options under s3Options; Strapi 4 kept them flat.
  const s3 = options.s3Options === undefined ? options : object(options.s3Options);
  const credentials = s3.credentials === undefined ? s3 : object(s3.credentials);
  if (options.rootPath !== undefined && options.rootPath !== null && options.rootPath !== "")
    gaps.push(
      gap(
        "uploadRootPath",
        "the aws-s3 upload provider's rootPath has no counterpart; set the s3 disk's root in config/filesystems.php.",
      ),
    );
  return {
    kind: "s3",
    ...settings([
      ["accessKeyId", credentials.accessKeyId],
      ["secretAccessKey", credentials.secretAccessKey],
      ["region", s3.region],
      ["bucket", object(s3.params).Bucket],
      ["endpoint", s3.endpoint],
      ["pathStyle", s3.forcePathStyle],
      ["baseUrl", options.baseUrl],
    ]),
  };
};

const cloudinaryStorage = (config: Options, gaps: CapabilityGap[]): FileStorage => {
  const options = object(config.providerOptions);
  // actionOptions pass extra upload/delete parameters (a folder, tags, …) on every call.
  const actions = Object.values(object(config.actionOptions)).some(
    (action) => Object.keys(object(action)).length > 0,
  );
  if (actions)
    gaps.push(
      gap(
        "uploadProviderOption",
        "the cloudinary upload provider's actionOptions have no counterpart; set the cloudinary disk's prefix in config/camis.php for a folder.",
      ),
    );
  return {
    kind: "cloudinary",
    ...settings([
      ["cloudName", options.cloud_name],
      ["apiKey", options.api_key],
      ["apiSecret", options.api_secret],
    ]),
  };
};

const typeList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((type) => typeof type === "string")
    ? (value as string[])
    : undefined;

/** upload.security's allowedTypes and deniedTypes, each kept only as a literal list of types. */
const security = (
  config: Options,
  gaps: CapabilityGap[],
): Pick<UploadSettings, "allowedTypes" | "deniedTypes"> => {
  const options = object(config.security);
  const lists: Pick<UploadSettings, "allowedTypes" | "deniedTypes"> = {};
  for (const key of ["allowedTypes", "deniedTypes"] as const) {
    if (options[key] === undefined || options[key] === null) continue;
    const list = typeList(options[key]);
    if (list === undefined)
      gaps.push(
        gap(
          "uploadSecurity",
          `the upload plugin's security.${key} is not a list of MIME types; set CAMIS_UPLOAD_${key === "allowedTypes" ? "ALLOWED" : "DENIED"}_TYPES by hand.`,
        ),
      );
    else lists[key] = list;
  }
  return lists;
};

const upload = (config: Options, gaps: CapabilityGap[]): UploadSettings | undefined => {
  const provider = typeof config.provider === "string" ? config.provider : "local";
  const limits = { ...settings([["sizeLimit", config.sizeLimit]]), ...security(config, gaps) };
  if (provider === "local") return { provider, storage: { kind: "local" }, ...limits };
  if (provider === "aws-s3")
    return { provider, storage: s3Storage(object(config.providerOptions), gaps), ...limits };
  if (provider === "cloudinary")
    return { provider, storage: cloudinaryStorage(config, gaps), ...limits };
  gaps.push(
    gap(
      "uploadProvider",
      `the upload provider "${provider}" has no counterpart here; files stay on the local disk until one is configured.`,
    ),
  );
  return undefined;
};

/** "https://email.eu-west-1.amazonaws.com" → "eu-west-1". */
const sesRegion = (address: unknown): Setting | undefined => {
  if (typeof address !== "string") return setting(address);
  return /email\.([a-z0-9-]+)\.amazonaws\.com/.exec(address)?.[1];
};

const hostOf = (address: unknown): Setting | undefined =>
  typeof address === "string"
    ? address.replace(/^https?:\/\//, "").replace(/\/+$/, "")
    : setting(address);

const transport = (
  provider: string,
  options: Options,
  gaps: CapabilityGap[],
): MailTransport | undefined => {
  switch (provider) {
    case "sendmail":
      return { kind: "sendmail" };
    case "nodemailer": {
      if (options.service !== undefined)
        gaps.push(
          gap(
            "emailProviderOption",
            `nodemailer's service "${String(options.service)}" names no host here; set MAIL_HOST and MAIL_PORT by hand.`,
          ),
        );
      const auth = object(options.auth);
      return {
        kind: "smtp",
        ...settings([
          ["host", options.host],
          ["port", options.port],
          ["secure", options.secure],
          ["username", auth.user],
          ["password", auth.pass],
        ]),
      };
    }
    case "sendgrid":
      // SendGrid's SMTP relay takes the API key as the password of the user "apikey".
      return {
        kind: "smtp",
        host: "smtp.sendgrid.net",
        port: 587,
        username: "apikey",
        ...settings([["password", options.apiKey]]),
      };
    case "mailgun":
      return {
        kind: "mailgun",
        ...settings([
          ["secret", options.key],
          ["domain", options.domain],
          ["endpoint", hostOf(options.url)],
        ]),
      };
    case "amazon-ses": {
      const credentials = object(options.credentials);
      return {
        kind: "ses",
        ...settings([
          ["accessKeyId", credentials.accessKeyId ?? options.key],
          ["secretAccessKey", credentials.secretAccessKey ?? options.secret],
          ["region", options.region ?? sesRegion(options.amazon)],
        ]),
      };
    }
    default:
      gaps.push(
        gap(
          "emailProvider",
          `the email provider "${provider}" has no counterpart here; mail is sent as the app's mail settings say.`,
        ),
      );
      return undefined;
  }
};

const email = (config: Options, gaps: CapabilityGap[]): EmailSettings | undefined => {
  // Strapi's email plugin defaults to sendmail.
  const provider = typeof config.provider === "string" ? config.provider : "sendmail";
  const chosen = transport(provider, object(config.providerOptions), gaps);
  if (chosen === undefined) return undefined;
  const mailSettings = object(config.settings);
  return {
    provider,
    transport: chosen,
    ...settings([
      ["defaultFrom", mailSettings.defaultFrom],
      ["defaultReplyTo", mailSettings.defaultReplyTo],
    ]),
  };
};

// Strapi serves REST lists with no largest page when config/api names none (0 here).
const rest = (api: Options): RestSettings => ({
  maxLimit: 0,
  ...settings([
    ["defaultLimit", api.defaultLimit],
    ["maxLimit", api.maxLimit],
    ["withCount", api.withCount],
  ]),
});

const graphql = (config: Options): PageSizes =>
  settings([
    ["defaultLimit", config.defaultLimit],
    ["maxLimit", config.maxLimit],
  ]);

const accounts = (config: Options): AccountSettings => {
  const sessions = object(config.sessions);
  const cookie = object(sessions.cookie);
  const allowed = object(config.register).allowedFields;
  const cookieSettings = settings([
    ["name", cookie.name],
    ["sameSite", cookie.sameSite],
    ["path", cookie.path],
    ["domain", cookie.domain],
    ["secure", cookie.secure],
  ]);
  const registerAllowedFields = Array.isArray(allowed)
    ? allowed.filter((f): f is string => typeof f === "string")
    : setting(allowed);
  return {
    ...settings([
      ["jwtManagement", config.jwtManagement],
      ["accessTokenLifespan", sessions.accessTokenLifespan],
      ["maxRefreshTokenLifespan", sessions.maxRefreshTokenLifespan],
      ["idleRefreshTokenLifespan", sessions.idleRefreshTokenLifespan],
      ["httpOnly", sessions.httpOnly],
    ]),
    ...(Object.keys(cookieSettings).length > 0 ? { cookie: cookieSettings } : {}),
    ...(registerAllowedFields === undefined ? {} : { registerAllowedFields }),
  };
};

const SENTRY_INIT = ["environment", "release", "sampleRate"];

const sentry = (config: Options, gaps: CapabilityGap[]): ErrorReportingSettings => {
  const init = object(config.init);
  if (config.sendMetadata === false)
    gaps.push(
      gap(
        "errorReportingOption",
        "the sentry plugin's sendMetadata: false has no counterpart; Laravel's SDK attaches the request to each event.",
      ),
    );
  const other = Object.keys(init).filter((key) => !SENTRY_INIT.includes(key));
  if (other.length > 0)
    gaps.push(
      gap(
        "errorReportingOption",
        `the sentry plugin's init options ${other.join(", ")} have no counterpart; set them in config/sentry.php.`,
      ),
    );
  return {
    provider: "sentry",
    ...settings([
      ["dsn", config.dsn],
      ["environment", init.environment],
      ["release", init.release],
      ["sampleRate", init.sampleRate],
    ]),
  };
};

/** A list option: a literal list (its items settings), or one setting holding a list. */
const listSetting = (value: unknown): Setting | Setting[] | undefined => {
  if (!Array.isArray(value)) return setting(value);
  const items = value.map(setting);
  return items.every((item) => item !== undefined) ? (items as Setting[]) : undefined;
};

const CORS_LISTS = ["origin", "methods", "headers", "expose"] as const;

/**
 * strapi::cors's options from config/middlewares (a list of names, or `{ name, config }`).
 * keepHeadersOnError has no counterpart to set: Laravel's HandleCors adds its headers to the
 * response an exception renders as well.
 */
const cors = (middlewares: unknown[], gaps: CapabilityGap[]): CorsSettings | undefined => {
  const entry = middlewares.find(
    (middleware) => middleware === "strapi::cors" || object(middleware).name === "strapi::cors",
  );
  if (entry === undefined) {
    gaps.push(
      gap(
        "corsMiddleware",
        "config/middlewares has no strapi::cors; the app still answers cross-origin requests as CAMIS_CORS_ORIGIN says (any origin unless set).",
      ),
    );
    return undefined;
  }
  const options = object(object(entry).config);
  const read: CorsSettings = {};
  for (const key of CORS_LISTS) {
    if (options[key] === undefined || options[key] === null) continue;
    const list = listSetting(options[key]);
    if (list !== undefined) read[key] = list;
    else
      gaps.push(
        gap(
          key === "origin" ? "corsOrigin" : "corsOption",
          `strapi::cors's ${key} is computed per request; set CAMIS_CORS_${key.toUpperCase()} by hand.`,
        ),
      );
  }
  Object.assign(
    read,
    settings([
      ["maxAge", options.maxAge],
      ["credentials", options.credentials],
    ]),
  );
  return Object.keys(read).length > 0 ? read : undefined;
};

/**
 * How a Strapi project is run, from its config/plugins (the upload, email, graphql,
 * users-permissions and sentry plugins), config/api and config/middlewares (strapi::cors), each
 * `env()` read kept as a reference to the variable, never its value. Options with no counterpart
 * are gaps.
 */
export const deploymentSettings = (
  plugins: unknown,
  api?: unknown,
  middlewares?: unknown,
): { settings: DeploymentSettings; gaps: CapabilityGap[] } => {
  const gaps: CapabilityGap[] = [];
  const config = object(plugins);
  const out: DeploymentSettings = {};
  const pluginConfig = (name: string): Options => object(object(config[name]).config);
  if (config.upload !== undefined) {
    const read = upload(pluginConfig("upload"), gaps);
    if (read !== undefined) out.upload = read;
  }
  if (config.email !== undefined) {
    const read = email(pluginConfig("email"), gaps);
    if (read !== undefined) out.email = read;
  }
  const restConfig = object(api).rest;
  if (restConfig !== undefined) out.rest = rest(object(restConfig));
  if (config.graphql !== undefined) {
    const read = graphql(pluginConfig("graphql"));
    if (Object.keys(read).length > 0) out.graphql = read;
  }
  if (config["users-permissions"] !== undefined) {
    const read = accounts(pluginConfig("users-permissions"));
    if (Object.keys(read).length > 0) out.accounts = read;
  }
  // Strapi's sentry plugin is on unless the project turns it off.
  if (config.sentry !== undefined && object(config.sentry).enabled !== false)
    out.errorReporting = sentry(pluginConfig("sentry"), gaps);
  if (Array.isArray(middlewares)) {
    const read = cors(middlewares, gaps);
    if (read !== undefined) out.cors = read;
  }
  return { settings: out, gaps };
};
