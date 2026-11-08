import {
  isEnvReference,
  type AccountSettings,
  type PageSizes,
  type RestSettings,
  type EmailSettings,
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

const upload = (config: Options, gaps: CapabilityGap[]): UploadSettings | undefined => {
  const provider = typeof config.provider === "string" ? config.provider : "local";
  const sizeLimit = settings([["sizeLimit", config.sizeLimit]]);
  if (provider === "local") return { provider, storage: { kind: "local" }, ...sizeLimit };
  if (provider === "aws-s3")
    return { provider, storage: s3Storage(object(config.providerOptions), gaps), ...sizeLimit };
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

/**
 * How a Strapi project is run, from its config/plugins (the upload, email, graphql and
 * users-permissions plugins) and config/api, each `env()` read kept as a reference to the
 * variable, never its value. Options with no counterpart are gaps.
 */
export const deploymentSettings = (
  plugins: unknown,
  api?: unknown,
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
  return { settings: out, gaps };
};
