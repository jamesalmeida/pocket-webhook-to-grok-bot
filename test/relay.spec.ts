import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const SECRET = "pocket-test-secret";
const WEBHOOK_URL = "https://grokbot.example/hook";
const BODY =
  '{"event":"summary.completed","recording":{"id":"rec_1"},"transcript":[{"text":"do-not-log-this-phrase"}]}';
// HMAC-SHA256(SECRET, "1700000000000." + BODY), from Node's crypto.createHmac.
const KNOWN_SIGNATURE = "5e33ecdab895f1f3a09cd7df97bdb2e4db0530396731525839f6465dbe1e9292";

const baseEnv: Env = {
  POCKET_SIGNING_SECRET: SECRET,
  GROKBOT_WEBHOOK_URL: WEBHOOK_URL,
  GROKBOT_AUTH_HEADER: "Bearer test-token",
};

type Captured = {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
  redirect?: string;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pocket webhook relay", () => {
  it("forwards a valid signature byte-for-byte with the Authorization header", async () => {
    const timestamp = String(Date.now());
    const captured = mockDownstream(new Response("accepted", { status: 202 }));
    const logs = spyLogs();

    const response = await post(
      baseEnv,
      BODY,
      signedHeaders(timestamp, await sign(SECRET, timestamp, BODY)),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(WEBHOOK_URL);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].headers.get("authorization")).toBe("Bearer test-token");
    expect(captured[0].headers.get("content-type")).toBe("application/json");
    expect(captured[0].headers.get("x-heypocket-timestamp")).toBe(timestamp);
    expect(captured[0].redirect).toBe("manual");
    expect(captured[0].body).toEqual(new TextEncoder().encode(BODY));

    const summary = JSON.parse(logs.log.mock.calls[0][0] as string) as {
      verified: boolean;
      event?: string;
      id?: string;
      downstream?: number;
    };
    expect(summary).toEqual({
      verified: true,
      event: "summary.completed",
      id: "rec_1",
      downstream: 202,
    });
    expect(JSON.stringify(logs.log.mock.calls)).not.toContain("do-not-log-this-phrase");
    expect(JSON.stringify(logs.log.mock.calls)).not.toContain(SECRET);
  });

  it("accepts a known HMAC vector, a sha256= prefix, and a seconds timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const captured = mockDownstream(new Response("accepted", { status: 200 }));

    expect(await sign(SECRET, "1700000000000", BODY)).toBe(KNOWN_SIGNATURE);

    const prefixed = await post(baseEnv, BODY, {
      "x-heypocket-timestamp": "1700000000000",
      "x-heypocket-signature": `sha256=${KNOWN_SIGNATURE.toUpperCase()}`,
    });
    expect(prefixed.status).toBe(200);
    expect(captured[0].body).toEqual(new TextEncoder().encode(BODY));

    const seconds = String(Math.floor(1_700_000_000_000 / 1000));
    const secondsResponse = await post(
      baseEnv,
      BODY,
      signedHeaders(seconds, await sign(SECRET, seconds, BODY)),
    );
    expect(secondsResponse.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[1].headers.get("x-heypocket-timestamp")).toBe(seconds);
  });

  it("rejects a bad signature with 401 and does not call downstream", async () => {
    const timestamp = String(Date.now());
    forbidFetch();
    const logs = spyLogs();

    const response = await post(
      baseEnv,
      BODY,
      signedHeaders(timestamp, "0".repeat(64)),
    );

    expect(response.status).toBe(401);
    const summary = JSON.parse(logs.log.mock.calls[0][0] as string) as { verified: boolean };
    expect(summary.verified).toBe(false);
  });

  it("rejects missing signature or timestamp headers with 401", async () => {
    const timestamp = String(Date.now());
    forbidFetch();

    const noSignature = await post(baseEnv, BODY, { "x-heypocket-timestamp": timestamp });
    const noTimestamp = await post(baseEnv, BODY, {
      "x-heypocket-signature": "aa",
    });
    const neither = await post(baseEnv, BODY, {});

    expect(noSignature.status).toBe(401);
    expect(noTimestamp.status).toBe(401);
    expect(neither.status).toBe(401);
  });

  it("rejects a stale timestamp with 401", async () => {
    forbidFetch();
    const timestamp = String(Date.now() - 6 * 60 * 1000);
    const response = await post(
      baseEnv,
      BODY,
      signedHeaders(timestamp, await sign(SECRET, timestamp, BODY)),
    );
    expect(response.status).toBe(401);

    vi.restoreAllMocks();
    const freshEnough = String(Date.now() - 4 * 60 * 1000);
    const captured = mockDownstream(new Response("accepted", { status: 200 }));
    const allowed = await post(
      baseEnv,
      BODY,
      signedHeaders(freshEnough, await sign(SECRET, freshEnough, BODY)),
    );
    expect(allowed.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("fails closed with 503 when the signing secret is unset", async () => {
    forbidFetch();
    const timestamp = String(Date.now());
    const headers = signedHeaders(timestamp, await sign(SECRET, timestamp, BODY));

    const omitted = await post(
      {
        GROKBOT_WEBHOOK_URL: WEBHOOK_URL,
        GROKBOT_AUTH_HEADER: "Bearer test-token",
      } as Env,
      BODY,
      headers,
    );
    const empty = await post({ ...baseEnv, POCKET_SIGNING_SECRET: "" }, BODY, headers);

    expect(omitted.status).toBe(503);
    expect(empty.status).toBe(503);
    expect(await omitted.text()).toBe("misconfigured");
  });

  it("returns 502 when downstream returns 500 and logs status plus a short snippet", async () => {
    const timestamp = String(Date.now());
    mockDownstream(new Response("upstream exploded", { status: 500 }));
    const logs = spyLogs();

    const response = await post(
      baseEnv,
      BODY,
      signedHeaders(timestamp, await sign(SECRET, timestamp, BODY)),
    );

    expect(response.status).toBe(502);
    expect(logs.error).toHaveBeenCalledOnce();
    const logged = JSON.parse(logs.error.mock.calls[0][0] as string) as {
      status: number;
      snippet: string;
    };
    expect(logged.status).toBe(500);
    expect(logged.snippet).toContain("upstream exploded");
    expect(logged.snippet).not.toContain(SECRET);
    expect(logged.snippet).not.toContain("do-not-log-this-phrase");

    const summary = JSON.parse(logs.log.mock.calls[0][0] as string) as {
      verified: boolean;
      downstream: number;
    };
    expect(summary.verified).toBe(true);
    expect(summary.downstream).toBe(500);
  });

  it("returns 502 when the downstream request fails", async () => {
    const timestamp = String(Date.now());
    const logs = spyLogs();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error(`connect failed ${WEBHOOK_URL} Authorization: Bearer test-token`);
    });

    const response = await post(
      baseEnv,
      BODY,
      signedHeaders(timestamp, await sign(SECRET, timestamp, BODY)),
    );

    expect(response.status).toBe(502);
    const logged = JSON.parse(logs.error.mock.calls[0][0] as string) as { snippet: string };
    expect(logged.snippet).toContain("connect failed");
    expect(logged.snippet).not.toContain(WEBHOOK_URL);
    expect(logged.snippet).not.toContain("Bearer test-token");
    expect(logged.snippet).not.toContain(SECRET);
  });

  it("strips a leading Authorization: prefix from GROKBOT_AUTH_HEADER", async () => {
    const timestamp = String(Date.now());
    const captured = mockDownstream(new Response("accepted", { status: 200 }));
    const signature = await sign(SECRET, timestamp, BODY);

    const response = await post(
      { ...baseEnv, GROKBOT_AUTH_HEADER: "Authorization: Bearer prefixed-token" },
      BODY,
      signedHeaders(timestamp, signature),
    );

    expect(response.status).toBe(200);
    expect(captured[0].headers.get("authorization")).toBe("Bearer prefixed-token");
  });

  it("answers GET / with ok and rejects other methods", async () => {
    forbidFetch();
    const health = await worker.fetch(new Request("https://relay.example/"), baseEnv);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const put = await worker.fetch(
      new Request("https://relay.example/", { method: "PUT" }),
      baseEnv,
    );
    expect(put.status).toBe(405);
  });
});

function signedHeaders(timestamp: string, signature: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-heypocket-timestamp": timestamp,
    "x-heypocket-signature": signature,
  };
}

async function post(env: Env, body: string, headers: Record<string, string>): Promise<Response> {
  return worker.fetch(
    new Request("https://relay.example/", {
      method: "POST",
      headers,
      body,
    }),
    env,
  );
}

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mockDownstream(response: Response): Captured[] {
  const captured: Captured[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    captured.push({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
      redirect: init?.redirect,
    });
    return response.clone();
  });
  return captured;
}

function forbidFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("fetch should not be called");
  });
}

function spyLogs() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}
