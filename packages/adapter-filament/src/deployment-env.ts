import {
  isEnvReference,
  type EmailSettings,
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
export const deploymentEnv = (settings: DeploymentSettings): { env: string; packages: string[] } => {
  const sections: string[][] = [];
  const packages = new Set<string>();
  if (settings.upload !== undefined) sections.push(uploadLines(settings.upload, packages));
  if (settings.email !== undefined) sections.push(emailLines(settings.email, packages));
  if (sections.length === 0) return { env: "", packages: [] };
  const header = [
    "# From the Strapi project's config/plugins.",
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
  return /^[A-Za-z0-9_./:@${}-]*$/.test(text)
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

const uploadLines = (upload: UploadSettings, packages: Set<string>): string[] => {
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
  } else {
    lines.push(...line("CAMIS_UPLOAD_SIZE_LIMIT", upload.sizeLimit));
  }
  return lines;
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
