import { describe, expect, it } from "vitest";
import type { Endpoint } from "@camis/ir-schema";
import {
  endpointGuardNames,
  endpointGuardsTable,
  endpointThrottleEnv,
  isGuardedEndpoint,
} from "./endpoint-guards";

const plain: Endpoint = {
  name: "MemoPin",
  contentType: "Memo",
  method: "POST",
  path: "/memos/pin",
};

describe("endpoint guards", () => {
  it("names each endpoint's throttle override after the endpoint, in one scheme for every target", () => {
    expect(endpointThrottleEnv("IngestEvents")).toBe(
      "CAMIS_ENDPOINT_INGEST_EVENTS_THROTTLE_PER_MINUTE",
    );
    expect(endpointThrottleEnv("MemoPin")).toBe("CAMIS_ENDPOINT_MEMO_PIN_THROTTLE_PER_MINUTE");
    expect(endpointThrottleEnv("Oauth2Callback")).toBe(
      "CAMIS_ENDPOINT_OAUTH2_CALLBACK_THROTTLE_PER_MINUTE",
    );
    expect(endpointThrottleEnv("HTTPPing")).toBe("CAMIS_ENDPOINT_HTTP_PING_THROTTLE_PER_MINUTE");
  });

  it("tells an endpoint with a guard from one with none", () => {
    expect(isGuardedEndpoint(plain)).toBe(false);
    expect(isGuardedEndpoint({ ...plain, public: true })).toBe(false);
    expect(isGuardedEndpoint({ ...plain, throttle: { perMinute: 5 } })).toBe(true);
    expect(isGuardedEndpoint({ ...plain, maxBodyBytes: 10 })).toBe(true);
    expect(isGuardedEndpoint({ ...plain, accepts: ["text/plain"] })).toBe(true);
    expect(isGuardedEndpoint({ ...plain, public: true, crossOrigin: { headers: [] } })).toBe(true);
  });

  it("names the guards an endpoint declares, in the order its route checks them", () => {
    expect(endpointGuardNames(plain)).toEqual([]);
    expect(
      endpointGuardNames({
        ...plain,
        public: true,
        crossOrigin: { headers: [] },
        accepts: ["text/plain"],
        throttle: { perMinute: 1 },
      }),
    ).toEqual(["throttle", "accepts", "crossOrigin"]);
  });

  it("tables each endpoint's guards for DEPLOY.md under the target's route prefix, a pipe and a backtick in a header escaped", () => {
    expect(
      endpointGuardsTable(
        [
          { ...plain, throttle: { perMinute: 5 }, maxBodyBytes: 64, accepts: ["Text/Plain"] },
          { ...plain, name: "Odd", public: true, crossOrigin: { headers: ["X|Key", "X`Key"] } },
          { ...plain, name: "Bare", public: true, crossOrigin: { headers: [] } },
        ],
        "/rest/v1",
      ).split("\n"),
    ).toEqual([
      "| Endpoint | Route | Requests a minute per address | Largest body (bytes) | Media types | Cross-origin request headers |",
      "| --- | --- | --- | --- | --- | --- |",
      `| \`${plain.name}\` | \`${plain.method} /rest/v1${plain.path}\` | 5 (\`${endpointThrottleEnv(plain.name)}\`) | 64 | \`text/plain\` |  |`,
      `| \`Odd\` | \`${plain.method} /rest/v1${plain.path}\` |  |  |  | \`X\\|Key\`, \`\` X\`Key \`\` |`,
      `| \`Bare\` | \`${plain.method} /rest/v1${plain.path}\` |  |  |  | none |`,
    ]);
  });
});
