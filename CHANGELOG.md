# Changelog

## Unreleased

### Added

- A Cloudflare Worker that verifies Pocket's HMAC webhook (`${X-HeyPocket-Timestamp}.${rawBody}`, hex digest in `X-HeyPocket-Signature`, 5-minute window) and forwards the raw body to a Grok Bot routine with the `Authorization` header from `GROKBOT_AUTH_HEADER`.
- `GET /` health check that returns `ok` without reading secrets or forwarding anything.
- Logging and traces on (`observability.enabled`, `observability.traces.enabled`) so `npx wrangler tail` and the dashboard show one JSON line per request, without secrets or the recording body.
- Setup docs: `README.md` for the deploy path, `GROK_BOT_SETUP.md` for a Grok Bot to walk a user through it, and `LOCAL_DEPLOY.md` for deploying this checkout under its live Worker name.
- A `scripts/send-test.mjs` signed test payload and a Vitest suite.
