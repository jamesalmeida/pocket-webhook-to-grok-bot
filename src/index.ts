const MAX_SKEW_MS = 5 * 60 * 1000;
// Unix milliseconds are 13 digits today (~1e12). Unix seconds are 10 digits (~1e9).
// Values below 1e11 cannot be millisecond timestamps in this century, so treat them as seconds.
const SECONDS_THRESHOLD = 1e11;
const SNIPPET_MAX = 180;
const SAFE_TOKEN = /^[\w.-]{1,80}$/;

type Summary = {
  verified: boolean;
  event?: string;
  id?: string;
  downstream?: number;
  reason?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      logSummary({ verified: false, reason: "health" });
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      logSummary({ verified: false, reason: "method_not_allowed" });
      return text("method not allowed", 405);
    }

    // Read the body once. Pocket signs these exact bytes; do not re-serialize.
    const raw = await request.arrayBuffer();
    const rawText = new TextDecoder().decode(raw);
    const meta = eventMeta(rawText);

    const secret = env.POCKET_SIGNING_SECRET;
    if (!secret) {
      console.error(JSON.stringify({ message: "POCKET_SIGNING_SECRET is unset" }));
      logSummary({ verified: false, reason: "missing_secret", ...meta });
      return text("misconfigured", 503);
    }

    const timestampHeader = request.headers.get("X-HeyPocket-Timestamp");
    const signatureHeader = request.headers.get("X-HeyPocket-Signature");
    if (!timestampHeader || !signatureHeader) {
      logSummary({ verified: false, reason: "missing_headers", ...meta });
      return text("unauthorized", 401);
    }

    const timestampMs = parseTimestampMs(timestampHeader);
    if (timestampMs === null) {
      logSummary({ verified: false, reason: "bad_timestamp", ...meta });
      return text("unauthorized", 401);
    }
    if (Math.abs(Date.now() - timestampMs) > MAX_SKEW_MS) {
      logSummary({ verified: false, reason: "stale_timestamp", ...meta });
      return text("unauthorized", 401);
    }

    // Sign the raw header string plus the raw body bytes, even when the skew
    // check treated a short timestamp as seconds.
    const expected = await hmacHex(secret, signedMessage(timestampHeader, raw));
    const provided = normalizeSignature(signatureHeader);
    if (!(await signaturesMatch(expected, provided))) {
      logSummary({ verified: false, reason: "bad_signature", ...meta });
      return text("unauthorized", 401);
    }

    const webhookUrl = env.GROKBOT_WEBHOOK_URL?.trim();
    const authorization = authorizationValue(env.GROKBOT_AUTH_HEADER);
    if (!webhookUrl || !authorization) {
      console.error(JSON.stringify({ message: "downstream webhook config is unset" }));
      logSummary({ verified: true, reason: "missing_downstream_config", ...meta });
      return text("misconfigured", 503);
    }

    let downstream: Response;
    try {
      downstream = await fetch(webhookUrl, {
        method: "POST",
        redirect: "manual",
        body: raw,
        headers: {
          "content-type": "application/json",
          authorization,
          "x-heypocket-timestamp": timestampHeader,
        },
      });
    } catch (err) {
      const snippet = scrub(err instanceof Error ? err.message : String(err), env);
      console.error(JSON.stringify({ message: "downstream fetch failed", snippet }));
      logSummary({ verified: true, reason: "downstream_fetch_failed", ...meta });
      return text("bad gateway", 502);
    }

    if (!downstream.ok) {
      const snippet = scrub(await downstream.text(), env);
      console.error(
        JSON.stringify({
          message: "downstream non-2xx",
          status: downstream.status,
          snippet,
        }),
      );
      logSummary({
        verified: true,
        ...meta,
        downstream: downstream.status,
      });
      return text("bad gateway", 502);
    }

    await downstream.body?.cancel();
    logSummary({ verified: true, ...meta, downstream: downstream.status });
    return text("ok", 200);
  },
} satisfies ExportedHandler<Env>;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function logSummary(summary: Summary): void {
  console.log(JSON.stringify(summary));
}

function eventMeta(rawText: string): { event?: string; id?: string } {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const event = token(obj.event);
    let id = token(obj.id);
    const recording = obj.recording;
    if (!id && recording && typeof recording === "object" && !Array.isArray(recording)) {
      id = token((recording as Record<string, unknown>).id);
    }
    return { event, id };
  } catch {
    return {};
  }
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

function parseTimestampMs(header: string): number | null {
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return null;
  return value < SECONDS_THRESHOLD ? value * 1000 : value;
}

function normalizeSignature(header: string): string {
  return header.trim().replace(/^sha256=/i, "").trim().toLowerCase();
}

function authorizationValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^authorization:\s*/i, "").trim();
  return stripped.length > 0 ? stripped : null;
}

function signedMessage(timestampHeader: string, raw: ArrayBuffer): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestampHeader}.`);
  const body = new Uint8Array(raw);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return message;
}

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signaturesMatch(expectedHex: string, providedHex: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // Hash both sides to a fixed size so a length mismatch cannot skip the compare.
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expectedHex)),
    crypto.subtle.digest("SHA-256", encoder.encode(providedHex)),
  ]);
  return crypto.subtle.timingSafeEqual(expectedHash, providedHash);
}

function scrub(text: string, env: Env): string {
  const secrets = [
    env.POCKET_SIGNING_SECRET,
    env.GROKBOT_WEBHOOK_URL,
    env.GROKBOT_AUTH_HEADER,
    authorizationValue(env.GROKBOT_AUTH_HEADER) ?? "",
  ];
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, SNIPPET_MAX);
}
