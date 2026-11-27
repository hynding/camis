import { describe, expect, it } from "vitest";
import type { Endpoint } from "@camis/ir-schema";
import { endpointThrottleEnv, isGuardedEndpoint } from "./endpoint-guards";

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
});
