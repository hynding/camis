import { describe, expect, it } from "vitest";
import { deploymentSettings } from "./deployment-settings";

// A Strapi project's config/plugins, as the CLI reads it: env('X', d) kept as { env, default }.
const env = (name: string, fallback?: string | number | boolean) =>
  fallback === undefined ? { env: name } : { env: name, default: fallback };

describe("deploymentSettings — upload", () => {
  it("keeps files locally when the project names no provider, or the local one", () => {
    expect(deploymentSettings({}).settings.upload).toBeUndefined();
    expect(
      deploymentSettings({ upload: { config: { provider: "local", sizeLimit: 1048576 } } }),
    ).toEqual({
      settings: { upload: { provider: "local", storage: { kind: "local" }, sizeLimit: 1048576 } },
      gaps: [],
    });
  });

  it("reads the MIME types upload.security allows and denies", () => {
    const { settings, gaps } = deploymentSettings({
      upload: { config: { security: { allowedTypes: ["image/*", "text/csv"], deniedTypes: [] } } },
    });
    expect(gaps).toEqual([]);
    expect(settings.upload).toEqual({
      provider: "local",
      storage: { kind: "local" },
      allowedTypes: ["image/*", "text/csv"],
      deniedTypes: [],
    });
  });

  it("reports a security list that is not a list of types", () => {
    const { settings, gaps } = deploymentSettings({
      upload: {
        config: { security: { allowedTypes: env("TYPES"), deniedTypes: ["image/svg+xml"] } },
      },
    });
    expect(settings.upload?.allowedTypes).toBeUndefined();
    expect(settings.upload?.deniedTypes).toEqual(["image/svg+xml"]);
    expect(gaps.map((g) => g.feature)).toEqual(["uploadSecurity"]);
  });

  it("reads the aws-s3 provider's bucket, credentials, region, endpoint and CDN address", () => {
    const { settings, gaps } = deploymentSettings({
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
    const { settings } = deploymentSettings({
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
    const rooted = deploymentSettings({
      upload: {
        config: {
          provider: "aws-s3",
          providerOptions: { rootPath: "site", s3Options: { params: { Bucket: "b" } } },
        },
      },
    });
    expect(rooted.gaps.map((g) => g.feature)).toEqual(["uploadRootPath"]);
    const uploadcare = deploymentSettings({
      upload: { config: { provider: "uploadcare", providerOptions: { public: "x" } } },
    });
    expect(uploadcare.settings.upload).toBeUndefined();
    expect(uploadcare.gaps).toEqual([
      {
        feature: "uploadProvider",
        location: {},
        severity: "downgrade",
        message:
          'the upload provider "uploadcare" has no counterpart here; files stay on the local disk until one is configured.',
      },
    ]);
  });

  it("reads the cloudinary provider's cloud name and credentials", () => {
    const { settings, gaps } = deploymentSettings({
      upload: {
        config: {
          provider: "cloudinary",
          providerOptions: {
            cloud_name: env("CLOUDINARY_NAME"),
            api_key: env("CLOUDINARY_KEY"),
            api_secret: env("CLOUDINARY_SECRET"),
          },
          actionOptions: { upload: {}, uploadStream: {}, delete: {} },
        },
      },
    });
    expect(gaps).toEqual([]);
    expect(settings.upload).toEqual({
      provider: "cloudinary",
      storage: {
        kind: "cloudinary",
        cloudName: env("CLOUDINARY_NAME"),
        apiKey: env("CLOUDINARY_KEY"),
        apiSecret: env("CLOUDINARY_SECRET"),
      },
    });
  });

  it("reports the cloudinary upload options it cannot carry", () => {
    const { gaps } = deploymentSettings({
      upload: {
        config: {
          provider: "cloudinary",
          providerOptions: { cloud_name: "demo" },
          actionOptions: { upload: { folder: "site" } },
        },
      },
    });
    expect(gaps.map((g) => g.feature)).toEqual(["uploadProviderOption"]);
  });
});

describe("deploymentSettings — email", () => {
  it("sends through sendmail when the project names no provider, as Strapi does", () => {
    expect(
      deploymentSettings({ email: { config: { settings: { defaultFrom: "a@b.co" } } } }).settings
        .email,
    ).toEqual({ provider: "sendmail", transport: { kind: "sendmail" }, defaultFrom: "a@b.co" });
  });

  it("reads nodemailer's SMTP host, port, security and account, and the default addresses", () => {
    expect(
      deploymentSettings({
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
    const { gaps } = deploymentSettings({
      email: { config: { provider: "nodemailer", providerOptions: { service: "gmail" } } },
    });
    expect(gaps.map((g) => g.feature)).toEqual(["emailProviderOption"]);
  });

  it("sends SendGrid mail through its SMTP relay, with the API key as the password", () => {
    expect(
      deploymentSettings({
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
      deploymentSettings({
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
      deploymentSettings({ email: { config: { provider: "amazon-ses", providerOptions } } })
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
    const { settings, gaps } = deploymentSettings({
      email: { config: { provider: "postmark", providerOptions: {} } },
    });
    expect(settings.email).toBeUndefined();
    expect(gaps.map((g) => g.feature)).toEqual(["emailProvider"]);
  });
});

describe("deploymentSettings — the API and accounts", () => {
  it("reads config/api's REST page sizes and count", () => {
    expect(
      deploymentSettings(
        {},
        { rest: { defaultLimit: 10, maxLimit: env("MAX", 50), withCount: false } },
      ).settings,
    ).toEqual({ rest: { defaultLimit: 10, maxLimit: env("MAX", 50), withCount: false } });
  });

  it("reads REST with no maximum as uncapped, as Strapi serves it", () => {
    expect(deploymentSettings({}, { rest: { defaultLimit: 10 } }).settings.rest).toEqual({
      defaultLimit: 10,
      maxLimit: 0,
    });
  });

  it("reads the graphql plugin's page sizes", () => {
    expect(
      deploymentSettings({
        graphql: { config: { defaultLimit: 20, maxLimit: 200, depthLimit: 7 } },
      }).settings,
    ).toEqual({ graphql: { defaultLimit: 20, maxLimit: 200 } });
  });

  it("reads users-permissions' session management, lifespans, cookie and register fields", () => {
    expect(
      deploymentSettings({
        "users-permissions": {
          config: {
            jwtManagement: "refresh",
            sessions: {
              accessTokenLifespan: 1800,
              maxRefreshTokenLifespan: env("MAX_REFRESH"),
              idleRefreshTokenLifespan: 86400,
              httpOnly: true,
              cookie: {
                name: "rt",
                sameSite: "strict",
                path: "/api",
                domain: "example.com",
                secure: true,
              },
            },
            register: { allowedFields: ["nickname", "picture"] },
          },
        },
      }).settings,
    ).toEqual({
      accounts: {
        jwtManagement: "refresh",
        accessTokenLifespan: 1800,
        maxRefreshTokenLifespan: env("MAX_REFRESH"),
        idleRefreshTokenLifespan: 86400,
        httpOnly: true,
        cookie: {
          name: "rt",
          sameSite: "strict",
          path: "/api",
          domain: "example.com",
          secure: true,
        },
        registerAllowedFields: ["nickname", "picture"],
      },
    });
  });
});

describe("deploymentSettings — sentry", () => {
  it("reads the sentry plugin's DSN and the init options Laravel's SDK takes", () => {
    const { settings, gaps } = deploymentSettings({
      sentry: {
        enabled: true,
        config: {
          dsn: env("SENTRY_DSN"),
          sendMetadata: true,
          init: { environment: env("NODE_ENV"), release: "site@1.2.3", sampleRate: 0.5 },
        },
      },
    });
    expect(gaps).toEqual([]);
    expect(settings.errorReporting).toEqual({
      provider: "sentry",
      dsn: env("SENTRY_DSN"),
      environment: env("NODE_ENV"),
      release: "site@1.2.3",
      sampleRate: 0.5,
    });
  });

  it("reads nothing from a disabled plugin", () => {
    const { settings } = deploymentSettings({
      sentry: { enabled: false, config: { dsn: env("SENTRY_DSN") } },
    });
    expect(settings.errorReporting).toBeUndefined();
  });

  it("reports the options it cannot carry", () => {
    const { gaps } = deploymentSettings({
      sentry: {
        config: {
          dsn: env("SENTRY_DSN"),
          sendMetadata: false,
          init: { beforeSend: "fn", debug: true },
        },
      },
    });
    expect(gaps.map((g) => [g.feature, g.message])).toEqual([
      [
        "errorReportingOption",
        "the sentry plugin's sendMetadata: false has no counterpart; Laravel's SDK attaches the request to each event.",
      ],
      [
        "errorReportingOption",
        "the sentry plugin's init options beforeSend, debug have no counterpart; set them in config/sentry.php.",
      ],
    ]);
  });
});

describe("deploymentSettings — strapi::cors in config/middlewares", () => {
  const cors = (config: unknown) => ["strapi::errors", { name: "strapi::cors", config }];

  it("reads strapi::cors's origin, methods, headers, exposed headers, max age and credentials", () => {
    expect(
      deploymentSettings(
        {},
        undefined,
        cors({
          origin: ["https://app.example.com", env("FRONTEND_URL")],
          methods: ["GET", "POST"],
          headers: "Content-Type,Authorization",
          expose: ["X-Total-Count"],
          maxAge: 600,
          credentials: env("CORS_CREDENTIALS", true),
          keepHeadersOnError: true,
        }),
      ).settings,
    ).toEqual({
      cors: {
        origin: ["https://app.example.com", env("FRONTEND_URL")],
        methods: ["GET", "POST"],
        headers: "Content-Type,Authorization",
        expose: ["X-Total-Count"],
        maxAge: 600,
        credentials: env("CORS_CREDENTIALS", true),
      },
    });
  });

  it("keeps an origin read from one variable as a reference to it", () => {
    expect(
      deploymentSettings({}, undefined, cors({ origin: env("CORS_ORIGIN") })).settings.cors,
    ).toEqual({ origin: env("CORS_ORIGIN") });
  });

  it("leaves CORS at its defaults for strapi::cors with no config, or none at all", () => {
    const { settings, gaps } = deploymentSettings({}, undefined, ["strapi::cors"]);
    expect(settings.cors).toBeUndefined();
    expect(gaps).toEqual([]);
    expect(deploymentSettings({}).settings.cors).toBeUndefined();
  });

  // A function origin decides per request; the config reader gives it back as an empty object.
  it("reports an origin computed per request, and keeps the rest", () => {
    const { settings, gaps } = deploymentSettings({}, undefined, cors({ origin: {}, maxAge: 5 }));
    expect(settings.cors).toEqual({ maxAge: 5 });
    expect(gaps.map((g) => g.feature)).toEqual(["corsOrigin"]);
  });

  // Strapi then sends no CORS headers at all, or the project's own middleware does it.
  it("reports a middleware list without strapi::cors", () => {
    const { settings, gaps } = deploymentSettings({}, undefined, [
      "strapi::errors",
      "global::cors",
    ]);
    expect(settings.cors).toBeUndefined();
    expect(gaps.map((g) => g.feature)).toEqual(["corsMiddleware"]);
  });
});
