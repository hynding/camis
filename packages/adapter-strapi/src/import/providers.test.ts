import { describe, expect, it } from "vitest";
import { providerSettings } from "./providers";

// A Strapi project's config/plugins, as the CLI reads it: env('X', d) kept as { env, default }.
const env = (name: string, fallback?: string | number | boolean) =>
  fallback === undefined ? { env: name } : { env: name, default: fallback };

describe("providerSettings — upload", () => {
  it("keeps files locally when the project names no provider, or the local one", () => {
    expect(providerSettings({}).settings.upload).toBeUndefined();
    expect(
      providerSettings({ upload: { config: { provider: "local", sizeLimit: 1048576 } } }),
    ).toEqual({
      settings: { upload: { provider: "local", storage: { kind: "local" }, sizeLimit: 1048576 } },
      gaps: [],
    });
  });

  it("reads the aws-s3 provider's bucket, credentials, region, endpoint and CDN address", () => {
    const { settings, gaps } = providerSettings({
      upload: {
        config: {
          provider: "aws-s3",
          providerOptions: {
            baseUrl: env("CDN_URL"),
            s3Options: {
              credentials: {
                accessKeyId: env("AWS_ACCESS_KEY_ID"),
                secretAccessKey: env("AWS_ACCESS_SECRET"),
              },
              region: env("AWS_REGION"),
              endpoint: "http://localhost:9000",
              forcePathStyle: true,
              params: { ACL: env("AWS_ACL", "public-read"), Bucket: env("AWS_BUCKET") },
            },
          },
        },
      },
    });
    expect(gaps).toEqual([]);
    expect(settings.upload).toEqual({
      provider: "aws-s3",
      storage: {
        kind: "s3",
        accessKeyId: env("AWS_ACCESS_KEY_ID"),
        secretAccessKey: env("AWS_ACCESS_SECRET"),
        region: env("AWS_REGION"),
        bucket: env("AWS_BUCKET"),
        endpoint: "http://localhost:9000",
        pathStyle: true,
        baseUrl: env("CDN_URL"),
      },
    });
  });

  it("reads Strapi 4's flat aws-s3 options too", () => {
    const { settings } = providerSettings({
      upload: {
        config: {
          provider: "aws-s3",
          providerOptions: {
            accessKeyId: env("AWS_ACCESS_KEY_ID"),
            secretAccessKey: env("AWS_ACCESS_SECRET"),
            region: "eu-west-1",
            params: { Bucket: "media" },
          },
        },
      },
    });
    expect(settings.upload?.storage).toEqual({
      kind: "s3",
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_ACCESS_SECRET"),
      region: "eu-west-1",
      bucket: "media",
    });
  });

  it("reports what it cannot carry: a root path, and a provider with no counterpart", () => {
    const rooted = providerSettings({
      upload: {
        config: {
          provider: "aws-s3",
          providerOptions: { rootPath: "site", s3Options: { params: { Bucket: "b" } } },
        },
      },
    });
    expect(rooted.gaps.map((g) => g.feature)).toEqual(["uploadRootPath"]);
    const cloudinary = providerSettings({
      upload: { config: { provider: "cloudinary", providerOptions: { cloud_name: "x" } } },
    });
    expect(cloudinary.settings.upload).toBeUndefined();
    expect(cloudinary.gaps).toEqual([
      {
        feature: "uploadProvider",
        location: {},
        severity: "downgrade",
        message:
          'the upload provider "cloudinary" has no counterpart here; files stay on the local disk until one is configured.',
      },
    ]);
  });
});

describe("providerSettings — email", () => {
  it("sends through sendmail when the project names no provider, as Strapi does", () => {
    expect(
      providerSettings({ email: { config: { settings: { defaultFrom: "a@b.co" } } } }).settings
        .email,
    ).toEqual({ provider: "sendmail", transport: { kind: "sendmail" }, defaultFrom: "a@b.co" });
  });

  it("reads nodemailer's SMTP host, port, security and account, and the default addresses", () => {
    expect(
      providerSettings({
        email: {
          config: {
            provider: "nodemailer",
            providerOptions: {
              host: env("SMTP_HOST", "smtp.example.com"),
              port: env("SMTP_PORT", 587),
              secure: false,
              auth: { user: env("SMTP_USERNAME"), pass: env("SMTP_PASSWORD") },
            },
            settings: {
              defaultFrom: "Hello <hello@example.com>",
              defaultReplyTo: env("REPLY_TO"),
            },
          },
        },
      }),
    ).toEqual({
      settings: {
        email: {
          provider: "nodemailer",
          transport: {
            kind: "smtp",
            host: env("SMTP_HOST", "smtp.example.com"),
            port: env("SMTP_PORT", 587),
            secure: false,
            username: env("SMTP_USERNAME"),
            password: env("SMTP_PASSWORD"),
          },
          defaultFrom: "Hello <hello@example.com>",
          defaultReplyTo: env("REPLY_TO"),
        },
      },
      gaps: [],
    });
  });

  it("reports a nodemailer service preset, which names no host", () => {
    const { gaps } = providerSettings({
      email: { config: { provider: "nodemailer", providerOptions: { service: "gmail" } } },
    });
    expect(gaps.map((g) => g.feature)).toEqual(["emailProviderOption"]);
  });

  it("sends SendGrid mail through its SMTP relay, with the API key as the password", () => {
    expect(
      providerSettings({
        email: { config: { provider: "sendgrid", providerOptions: { apiKey: env("SG_KEY") } } },
      }).settings.email?.transport,
    ).toEqual({
      kind: "smtp",
      host: "smtp.sendgrid.net",
      port: 587,
      username: "apikey",
      password: env("SG_KEY"),
    });
  });

  it("reads mailgun's key, domain and regional address", () => {
    expect(
      providerSettings({
        email: {
          config: {
            provider: "mailgun",
            providerOptions: {
              key: env("MAILGUN_KEY"),
              domain: "mg.example.com",
              url: "https://api.eu.mailgun.net",
            },
          },
        },
      }).settings.email?.transport,
    ).toEqual({
      kind: "mailgun",
      secret: env("MAILGUN_KEY"),
      domain: "mg.example.com",
      endpoint: "api.eu.mailgun.net",
    });
  });

  it("reads amazon-ses's credentials and region, from either of its option shapes", () => {
    const transport = (providerOptions: Record<string, unknown>) =>
      providerSettings({ email: { config: { provider: "amazon-ses", providerOptions } } })
        .settings.email?.transport;
    expect(
      transport({
        key: env("SES_KEY"),
        secret: env("SES_SECRET"),
        amazon: "https://email.eu-west-1.amazonaws.com",
      }),
    ).toEqual({
      kind: "ses",
      accessKeyId: env("SES_KEY"),
      secretAccessKey: env("SES_SECRET"),
      region: "eu-west-1",
    });
    expect(
      transport({
        credentials: { accessKeyId: "AK", secretAccessKey: env("SES_SECRET") },
        region: env("AWS_REGION"),
      }),
    ).toEqual({
      kind: "ses",
      accessKeyId: "AK",
      secretAccessKey: env("SES_SECRET"),
      region: env("AWS_REGION"),
    });
  });

  it("reports a provider with no counterpart and leaves mail as it is", () => {
    const { settings, gaps } = providerSettings({
      email: { config: { provider: "postmark", providerOptions: {} } },
    });
    expect(settings.email).toBeUndefined();
    expect(gaps.map((g) => g.feature)).toEqual(["emailProvider"]);
  });
});
