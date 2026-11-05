// Secret names. Values are set with `wrangler secret put` or the dashboard, not in wrangler.jsonc,
// so `wrangler deploy` can create the Worker before any secret exists.
interface Env {
  POCKET_SIGNING_SECRET: string;
  GROKBOT_WEBHOOK_URL: string;
  GROKBOT_AUTH_HEADER: string;
}
