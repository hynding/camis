import { describe, expect, it } from "vitest";
import { providerEnv } from "./provider-env";

describe("providerEnv", () => {
  it("writes nothing for a project that keeps files locally and names no mail settings", () => {
    expect(providerEnv({})).toEqual({ env: "", packages: [] });
  });

  it("maps S3 storage onto Laravel's s3 disk and SMTP onto its smtp mailer", () => {
    const { env, packages } = providerEnv({
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
    expect(env).toBe(`# From the Strapi project's config/plugins.
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
      providerEnv({ email: { provider: "sendmail", transport: { kind: "sendmail" } } }).env,
    ).toContain("CAMIS_EMAIL_PROVIDER=sendmail\nMAIL_MAILER=sendmail\n");
    const mailgun = providerEnv({
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
    const ses = providerEnv({
      email: {
        provider: "amazon-ses",
        transport: { kind: "ses", accessKeyId: "AK", secretAccessKey: { env: "S" }, region: "us-east-1" },
      },
    });
    expect(ses.env).toContain(
      "MAIL_MAILER=ses\nAWS_ACCESS_KEY_ID=AK\nAWS_SECRET_ACCESS_KEY=${S}\nAWS_DEFAULT_REGION=us-east-1\n",
    );
    expect(ses.packages).toEqual(["aws/aws-sdk-php"]);
  });

  it("does not split a default sender it can only read from a variable", () => {
    const { env } = providerEnv({
      email: { provider: "sendmail", transport: { kind: "sendmail" }, defaultFrom: { env: "FROM" } },
    });
    expect(env).toContain("CAMIS_EMAIL_DEFAULT_FROM=${FROM}\n");
    expect(env).not.toContain("MAIL_FROM_ADDRESS");
  });

  it("keeps local storage on the default disk, writing only the size limit", () => {
    expect(
      providerEnv({ upload: { provider: "local", storage: { kind: "local" }, sizeLimit: 5 } }).env,
    ).toContain("# Upload: local\nCAMIS_UPLOAD_SIZE_LIMIT=5\n");
  });
});
