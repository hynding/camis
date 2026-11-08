/**
 * How a project is run, read from a source project's configuration and turned by a target into
 * its own (environment variables, disks, mailers): where it keeps its files, how it sends mail,
 * its API's page sizes and its accounts' sessions.
 * Deployment settings, not content: they live beside the IR, never in it.
 */

/** A configured value: a literal, or a reference to an environment variable (and its fallback). */
export type Setting = string | number | boolean | EnvReference;
export interface EnvReference {
  env: string;
  default?: string | number | boolean;
}

export type FileStorage =
  | { kind: "local" }
  | {
      kind: "s3";
      accessKeyId?: Setting;
      secretAccessKey?: Setting;
      region?: Setting;
      bucket?: Setting;
      /** An S3-compatible service's address (MinIO, R2, …). */
      endpoint?: Setting;
      pathStyle?: Setting;
      /** The public address files are served from, when not the bucket's own (a CDN). */
      baseUrl?: Setting;
    };

export interface UploadSettings {
  /** The provider name the source records on every file it stores. */
  provider: string;
  storage: FileStorage;
  /** The largest upload accepted, in bytes. */
  sizeLimit?: Setting;
}

export type MailTransport =
  | { kind: "sendmail" }
  | {
      kind: "smtp";
      host?: Setting;
      port?: Setting;
      /** TLS from the first byte (SMTPS), rather than STARTTLS. */
      secure?: Setting;
      username?: Setting;
      password?: Setting;
    }
  | { kind: "mailgun"; secret?: Setting; domain?: Setting; endpoint?: Setting }
  | { kind: "ses"; accessKeyId?: Setting; secretAccessKey?: Setting; region?: Setting };

export interface EmailSettings {
  /** The provider name the source configures, shown on its settings page. */
  provider: string;
  transport: MailTransport;
  /** "Name <address>" or an address. */
  defaultFrom?: Setting;
  defaultReplyTo?: Setting;
}

/** A list's page size when a request names none, and the largest one allowed. */
export interface PageSizes {
  defaultLimit?: Setting;
  /** The REST API's 0, or GraphQL's -1, allows any. */
  maxLimit?: Setting;
}

export interface RestSettings extends PageSizes {
  /** Whether a list counts its total. */
  withCount?: Setting;
}

/** End users' sign-in sessions, lifespans in seconds. */
export interface AccountSettings {
  /** "legacy-support" (one long-lived token) or "refresh" (access and refresh tokens). */
  jwtManagement?: Setting;
  accessTokenLifespan?: Setting;
  maxRefreshTokenLifespan?: Setting;
  idleRefreshTokenLifespan?: Setting;
  /** The refresh token travels in an httpOnly cookie rather than the body. */
  httpOnly?: Setting;
  cookie?: {
    name?: Setting;
    sameSite?: Setting;
    path?: Setting;
    domain?: Setting;
    secure?: Setting;
  };
  /** The user fields sign-up accepts beyond username, email and password. */
  registerAllowedFields?: Setting | string[];
}

export interface DeploymentSettings {
  upload?: UploadSettings;
  email?: EmailSettings;
  rest?: RestSettings;
  graphql?: PageSizes;
  accounts?: AccountSettings;
}

export const isEnvReference = (value: unknown): value is EnvReference =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { env?: unknown }).env === "string";
