/**
 * Where a project keeps its files and how it sends mail, read from a source project's
 * configuration and turned by a target into its own (environment variables, disks, mailers).
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

export interface ProviderSettings {
  upload?: UploadSettings;
  email?: EmailSettings;
}

export const isEnvReference = (value: unknown): value is EnvReference =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { env?: unknown }).env === "string";
