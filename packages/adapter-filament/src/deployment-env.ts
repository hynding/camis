import {
  isEnvReference,
  type AccountSettings,
  type CorsSettings,
  type PageSizes,
  type RestSettings,
  type EmailSettings,
  type ErrorReportingSettings,
  type DeploymentSettings,
  type Setting,
  type UploadSettings,
} from "@camis/adapter-kernel";

/**
 * The Laravel .env lines that give the app a source project's file storage and mail: the s3
 * disk and the mailers config/filesystems.php and config/mail.php already read, and the keys
 * config/camis.php reads. A value read from a variable stays a reference to it (`${NAME}`,
 * which Laravel's .env expands), so no secret is copied. `packages` are the Composer packages
 * Laravel needs for the chosen disk or mailer.
 */
export const deploymentEnv = (
  settings: DeploymentSettings,
): { env: string; packages: string[] } => {
  const sections: string[][] = [];
  const packages = new Set<string>();
  if (settings.upload !== undefined) sections.push(uploadLines(settings.upload, packages));
  if (settings.email !== undefined) sections.push(emailLines(settings.email, packages));
  if (settings.rest !== undefined) sections.push(restLines(settings.rest));
  if (settings.graphql !== undefined) sections.push(graphqlLines(settings.graphql));
  if (settings.accounts !== undefined) sections.push(accountLines(settings.accounts));
  if (settings.errorReporting !== undefined)
    sections.push(errorReportingLines(settings.errorReporting, packages));
  if (settings.cors !== undefined) sections.push(corsLines(settings.cors));
  if (sections.length === 0) return { env: "", packages: [] };
  const header = [
    "# From the Strapi project's config/plugins, config/api and config/middlewares.",
    "# ${NAME} reads the variable the Strapi project read: copy it from that project's .env.",
  ];
  return {
    env: `${[header, ...sections].map((lines) => lines.join("\n")).join("\n\n")}\n`,
    packages: [...packages].sort(),
  };
};

/** A .env value: quoted when it holds what an unquoted value cannot. */
const literal = (value: string | number | boolean): string => {
  const text = String(value);
  return /^[A-Za-z0-9_.,/:@${}-]*$/.test(text)
    ? text
    : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

/** One variable's lines: its value, a reference, or a note when it would read itself. */
const line = (name: string, value: Setting | undefined): string[] => {
  if (value === undefined) return [];
  if (!isEnvReference(value)) return [`${name}=${literal(value)}`];
  const fallback =
    value.default === undefined
      ? []
      : [`# The Strapi project falls back to ${String(value.default)} when ${value.env} is unset.`];
  if (value.env === name) return [`# ${name}: the Strapi project reads the same variable.`];
  return [...fallback, `${name}=\${${value.env}}`];
};

const typeLines = (upload: UploadSettings): string[] => [
  ...(upload.allowedTypes === undefined
    ? []
    : [`CAMIS_UPLOAD_ALLOWED_TYPES=${literal(upload.allowedTypes.join(","))}`]),
  ...(upload.deniedTypes === undefined
    ? []
    : [`CAMIS_UPLOAD_DENIED_TYPES=${literal(upload.deniedTypes.join(","))}`]),
];

const storageLines = (upload: UploadSettings, packages: Set<string>): string[] => {
  const lines = [`# Upload: ${upload.provider}`];
  const storage = upload.storage;
  if (storage.kind === "s3") {
    lines.push(`CAMIS_UPLOAD_PROVIDER=${literal(upload.provider)}`, "CAMIS_UPLOAD_DISK=s3");
    lines.push(...line("CAMIS_UPLOAD_SIZE_LIMIT", upload.sizeLimit));
    lines.push(
      ...line("AWS_ACCESS_KEY_ID", storage.accessKeyId),
      ...line("AWS_SECRET_ACCESS_KEY", storage.secretAccessKey),
      ...line("AWS_DEFAULT_REGION", storage.region),
      ...line("AWS_BUCKET", storage.bucket),
      ...line("AWS_ENDPOINT", storage.endpoint),
      ...line("AWS_USE_PATH_STYLE_ENDPOINT", storage.pathStyle),
      ...line("AWS_URL", storage.baseUrl),
    );
    packages.add("league/flysystem-aws-s3-v3");
  } else if (storage.kind === "cloudinary") {
    lines.push(`CAMIS_UPLOAD_PROVIDER=${literal(upload.provider)}`, "CAMIS_UPLOAD_DISK=cloudinary");
    lines.push(...line("CAMIS_UPLOAD_SIZE_LIMIT", upload.sizeLimit));
    lines.push(
      ...line("CLOUDINARY_CLOUD_NAME", storage.cloudName),
      ...line("CLOUDINARY_KEY", storage.apiKey),
      ...line("CLOUDINARY_SECRET", storage.apiSecret),
    );
    packages.add("cloudinary-labs/cloudinary-laravel");
  } else {
    lines.push(...line("CAMIS_UPLOAD_SIZE_LIMIT", upload.sizeLimit));
  }
  return lines;
};

const uploadLines = (upload: UploadSettings, packages: Set<string>): string[] => [
  ...storageLines(upload, packages),
  ...typeLines(upload),
];

const errorReportingLines = (
  reporting: ErrorReportingSettings,
  packages: Set<string>,
): string[] => {
  packages.add("sentry/sentry-laravel");
  return [
    `# Error reporting: ${reporting.provider}`,
    ...line("SENTRY_LARAVEL_DSN", reporting.dsn),
    ...line("SENTRY_ENVIRONMENT", reporting.environment),
    ...line("SENTRY_RELEASE", reporting.release),
    ...line("SENTRY_SAMPLE_RATE", reporting.sampleRate),
  ];
};

/** "Name <address>" → its address and name; a bare address → itself. */
const sender = (from: string): { address: string; name?: string } => {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return match === null
    ? { address: from.trim() }
    : { address: match[2]!.trim(), ...(match[1] === "" ? {} : { name: match[1]! }) };
};

const emailLines = (email: EmailSettings, packages: Set<string>): string[] => {
  const lines = [`# Email: ${email.provider}`, `CAMIS_EMAIL_PROVIDER=${literal(email.provider)}`];
  const transport = email.transport;
  switch (transport.kind) {
    case "sendmail":
      lines.push("MAIL_MAILER=sendmail");
      break;
    case "smtp":
      lines.push(
        "MAIL_MAILER=smtp",
        ...line("MAIL_HOST", transport.host),
        ...line("MAIL_PORT", transport.port),
        ...(transport.secure === true ? ["MAIL_SCHEME=smtps"] : []),
        ...(isEnvReference(transport.secure)
          ? [`# Set MAIL_SCHEME=smtps when ${transport.secure.env} is true (TLS from the start).`]
          : []),
        ...line("MAIL_USERNAME", transport.username),
        ...line("MAIL_PASSWORD", transport.password),
      );
      break;
    case "mailgun":
      lines.push(
        "# Laravel reads these through config/services.php's mailgun entry: add it if the app has none.",
        "MAIL_MAILER=mailgun",
        ...line("MAILGUN_SECRET", transport.secret),
        ...line("MAILGUN_DOMAIN", transport.domain),
        ...line("MAILGUN_ENDPOINT", transport.endpoint),
      );
      packages.add("symfony/http-client").add("symfony/mailgun-mailer");
      break;
    case "ses":
      lines.push(
        "MAIL_MAILER=ses",
        ...line("AWS_ACCESS_KEY_ID", transport.accessKeyId),
        ...line("AWS_SECRET_ACCESS_KEY", transport.secretAccessKey),
        ...line("AWS_DEFAULT_REGION", transport.region),
      );
      packages.add("aws/aws-sdk-php");
      break;
  }
  lines.push(...line("CAMIS_EMAIL_DEFAULT_FROM", email.defaultFrom));
  // Laravel's own sender is an address and a name; only a written one can be split.
  if (typeof email.defaultFrom === "string") {
    const from = sender(email.defaultFrom);
    lines.push(...line("MAIL_FROM_ADDRESS", from.address), ...line("MAIL_FROM_NAME", from.name));
  }
  lines.push(...line("CAMIS_EMAIL_DEFAULT_REPLY_TO", email.defaultReplyTo));
  return lines;
};

const restLines = (rest: RestSettings): string[] => [
  "# REST API",
  ...line("CAMIS_REST_DEFAULT_LIMIT", rest.defaultLimit),
  ...line("CAMIS_REST_MAX_LIMIT", rest.maxLimit),
  ...line("CAMIS_REST_WITH_COUNT", rest.withCount),
];

const graphqlLines = (graphql: PageSizes): string[] => [
  "# GraphQL",
  ...line("CAMIS_GRAPHQL_DEFAULT_LIMIT", graphql.defaultLimit),
  ...line("CAMIS_GRAPHQL_MAX_LIMIT", graphql.maxLimit),
];

const accountLines = (accounts: AccountSettings): string[] => {
  const allowed = accounts.registerAllowedFields;
  return [
    "# Users & Permissions",
    ...line("CAMIS_JWT_MANAGEMENT", accounts.jwtManagement),
    ...line("CAMIS_ACCESS_TOKEN_LIFESPAN", accounts.accessTokenLifespan),
    ...line("CAMIS_MAX_REFRESH_TOKEN_LIFESPAN", accounts.maxRefreshTokenLifespan),
    ...line("CAMIS_IDLE_REFRESH_TOKEN_LIFESPAN", accounts.idleRefreshTokenLifespan),
    ...line("CAMIS_SESSIONS_HTTP_ONLY", accounts.httpOnly),
    ...line("CAMIS_SESSIONS_COOKIE_NAME", accounts.cookie?.name),
    ...line("CAMIS_SESSIONS_COOKIE_SAME_SITE", accounts.cookie?.sameSite),
    ...line("CAMIS_SESSIONS_COOKIE_PATH", accounts.cookie?.path),
    ...line("CAMIS_SESSIONS_COOKIE_DOMAIN", accounts.cookie?.domain),
    ...line("CAMIS_SESSIONS_COOKIE_SECURE", accounts.cookie?.secure),
    // config/camis.php splits the list on commas.
    ...line("CAMIS_REGISTER_ALLOWED_FIELDS", Array.isArray(allowed) ? allowed.join(",") : allowed),
  ];
};

/** A literal list as one comma-separated value, each read variable spliced in as ${NAME}. */
const commaList = (list: Setting | Setting[] | undefined): Setting | undefined =>
  Array.isArray(list)
    ? list.map((item) => (isEnvReference(item) ? `\${${item.env}}` : String(item))).join(",")
    : list;

/** The fallbacks of the variables a literal list reads, which ${NAME} in the list cannot carry. */
const listFallbacks = (list: Setting | Setting[] | undefined): string[] =>
  Array.isArray(list)
    ? list.flatMap((item) =>
        isEnvReference(item) && item.default !== undefined
          ? [
              `# The Strapi project falls back to ${String(item.default)} when ${item.env} is unset.`,
            ]
          : [],
      )
    : [];

const corsLines = (cors: CorsSettings): string[] => [
  "# CORS (strapi::cors)",
  ...listFallbacks(cors.origin),
  ...line("CAMIS_CORS_ORIGIN", commaList(cors.origin)),
  ...line("CAMIS_CORS_METHODS", commaList(cors.methods)),
  // Strapi allows whichever headers a preflight asks for when the list is empty; so does `*`.
  ...line(
    "CAMIS_CORS_HEADERS",
    Array.isArray(cors.headers) && cors.headers.length === 0 ? "*" : commaList(cors.headers),
  ),
  ...line("CAMIS_CORS_EXPOSE", commaList(cors.expose)),
  ...line("CAMIS_CORS_MAX_AGE", cors.maxAge),
  ...line("CAMIS_CORS_CREDENTIALS", cors.credentials),
];
