import { describe, expect, it } from "vitest";
import { deploymentEnv } from "./deployment-env";

describe("deploymentEnv", () => {
  it("writes nothing for a project that keeps files locally and names no mail settings", () => {
    expect(deploymentEnv({})).toEqual({ env: "", packages: [] });
  });

  it("maps S3 storage onto Laravel's s3 disk and SMTP onto its smtp mailer", () => {
    const { env, packages } = deploymentEnv({
      upload: {
        provider: "aws-s3",
        storage: {
          kind: "s3",
          accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
          secretAccessKey: { env: "AWS_ACCESS_SECRET" },
          region: "eu-west-1",
          bucket: { env: "AWS_BUCKET" },
          endpoint: "http://localhost:9000",
          pathStyle: true,
          baseUrl: { env: "CDN_URL" },
        },
        sizeLimit: 1048576,
      },
      email: {
        provider: "nodemailer",
        transport: {
          kind: "smtp",
          host: { env: "SMTP_HOST", default: "smtp.example.com" },
          port: 465,
          secure: true,
          username: { env: "SMTP_USERNAME" },
          password: { env: "SMTP_PASSWORD" },
        },
        defaultFrom: "Hello Team <hello@example.com>",
        defaultReplyTo: { env: "REPLY_TO" },
      },
    });
    expect(env).toBe(`# From the Strapi project's config/plugins and config/api.
# \${NAME} reads the variable the Strapi project read: copy it from that project's .env.

# Upload: aws-s3
CAMIS_UPLOAD_PROVIDER=aws-s3
CAMIS_UPLOAD_DISK=s3
CAMIS_UPLOAD_SIZE_LIMIT=1048576
# AWS_ACCESS_KEY_ID: the Strapi project reads the same variable.
AWS_SECRET_ACCESS_KEY=\${AWS_ACCESS_SECRET}
AWS_DEFAULT_REGION=eu-west-1
# AWS_BUCKET: the Strapi project reads the same variable.
AWS_ENDPOINT=http://localhost:9000
AWS_USE_PATH_STYLE_ENDPOINT=true
AWS_URL=\${CDN_URL}

# Email: nodemailer
CAMIS_EMAIL_PROVIDER=nodemailer
MAIL_MAILER=smtp
# The Strapi project falls back to smtp.example.com when SMTP_HOST is unset.
MAIL_HOST=\${SMTP_HOST}
MAIL_PORT=465
MAIL_SCHEME=smtps
MAIL_USERNAME=\${SMTP_USERNAME}
MAIL_PASSWORD=\${SMTP_PASSWORD}
CAMIS_EMAIL_DEFAULT_FROM="Hello Team <hello@example.com>"
MAIL_FROM_ADDRESS=hello@example.com
MAIL_FROM_NAME="Hello Team"
CAMIS_EMAIL_DEFAULT_REPLY_TO=\${REPLY_TO}
`);
    expect(packages).toEqual(["league/flysystem-aws-s3-v3"]);
  });

  it("maps sendmail, mailgun and SES onto Laravel's mailers of those names", () => {
    expect(
      deploymentEnv({ email: { provider: "sendmail", transport: { kind: "sendmail" } } }).env,
    ).toContain("CAMIS_EMAIL_PROVIDER=sendmail\nMAIL_MAILER=sendmail\n");
    const mailgun = deploymentEnv({
      email: {
        provider: "mailgun",
        transport: {
          kind: "mailgun",
          secret: { env: "MAILGUN_KEY" },
          domain: "mg.example.com",
          endpoint: "api.eu.mailgun.net",
        },
      },
    });
    expect(mailgun.env).toContain(
      "MAIL_MAILER=mailgun\nMAILGUN_SECRET=${MAILGUN_KEY}\nMAILGUN_DOMAIN=mg.example.com\nMAILGUN_ENDPOINT=api.eu.mailgun.net\n",
    );
    expect(mailgun.packages).toEqual(["symfony/http-client", "symfony/mailgun-mailer"]);
    const ses = deploymentEnv({
      email: {
        provider: "amazon-ses",
        transport: {
          kind: "ses",
          accessKeyId: "AK",
          secretAccessKey: { env: "S" },
          region: "us-east-1",
        },
      },
    });
    expect(ses.env).toContain(
      "MAIL_MAILER=ses\nAWS_ACCESS_KEY_ID=AK\nAWS_SECRET_ACCESS_KEY=${S}\nAWS_DEFAULT_REGION=us-east-1\n",
    );
    expect(ses.packages).toEqual(["aws/aws-sdk-php"]);
  });

  it("does not split a default sender it can only read from a variable", () => {
    const { env } = deploymentEnv({
      email: {
        provider: "sendmail",
        transport: { kind: "sendmail" },
        defaultFrom: { env: "FROM" },
      },
    });
    expect(env).toContain("CAMIS_EMAIL_DEFAULT_FROM=${FROM}\n");
    expect(env).not.toContain("MAIL_FROM_ADDRESS");
  });

  it("keeps local storage on the default disk, writing only the size limit", () => {
    expect(
      deploymentEnv({ upload: { provider: "local", storage: { kind: "local" }, sizeLimit: 5 } })
        .env,
    ).toContain("# Upload: local\nCAMIS_UPLOAD_SIZE_LIMIT=5\n");
  });
});

describe("deploymentEnv — the API and accounts", () => {
  it("writes the REST and GraphQL page sizes and the users-permissions settings config/camis.php reads", () => {
    const { env } = deploymentEnv({
      rest: { defaultLimit: 10, maxLimit: 0, withCount: false },
      graphql: { defaultLimit: 20, maxLimit: { env: "GQL_MAX" } },
      accounts: {
        jwtManagement: "refresh",
        accessTokenLifespan: 1800,
        httpOnly: true,
        cookie: { name: "rt", sameSite: "strict", secure: true },
        registerAllowedFields: ["nickname", "picture"],
      },
    });
    expect(env).toContain(`# REST API
CAMIS_REST_DEFAULT_LIMIT=10
CAMIS_REST_MAX_LIMIT=0
CAMIS_REST_WITH_COUNT=false

# GraphQL
CAMIS_GRAPHQL_DEFAULT_LIMIT=20
CAMIS_GRAPHQL_MAX_LIMIT=\${GQL_MAX}

# Users & Permissions
CAMIS_JWT_MANAGEMENT=refresh
CAMIS_ACCESS_TOKEN_LIFESPAN=1800
CAMIS_SESSIONS_HTTP_ONLY=true
CAMIS_SESSIONS_COOKIE_NAME=rt
CAMIS_SESSIONS_COOKIE_SAME_SITE=strict
CAMIS_SESSIONS_COOKIE_SECURE=true
CAMIS_REGISTER_ALLOWED_FIELDS=nickname,picture
`);
  });
});
