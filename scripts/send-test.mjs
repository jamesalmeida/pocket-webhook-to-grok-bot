#!/usr/bin/env node
// Sign a sample Pocket payload and POST it at the Worker URL.
//
//   POCKET_SIGNING_SECRET='your secret' node scripts/send-test.mjs https://pocket-webhook-to-grok-bot.<your-subdomain>.workers.dev/

import { createHmac } from "node:crypto";

const url = process.argv[2];
const secret = process.env.POCKET_SIGNING_SECRET;

if (!url || !secret) {
  console.error(
    "Usage: POCKET_SIGNING_SECRET='...' node scripts/send-test.mjs <webhook-url>",
  );
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("The webhook URL is not a valid URL.");
  process.exit(1);
}
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
  console.error("The webhook URL must be http or https.");
  process.exit(1);
}

const payload = {
  event: "summary.completed",
  timestamp: new Date().toISOString(),
  recording: { id: "rec_send_test" },
};
const body = JSON.stringify(payload);
const timestamp = String(Date.now());
const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "HeyPocket-Webhook/1.0",
    "x-heypocket-signature": signature,
    "x-heypocket-timestamp": timestamp,
  },
  body,
});

const text = await response.text();
console.log(`${response.status} ${text.slice(0, 180)}`);
process.exit(response.ok ? 0 : 1);
