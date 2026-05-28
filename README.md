# Tacobot 🌮

Internal Slack recognition program for the `wlt-and-shaman` workspace. Inspired by [HeyTaco](https://www.heytaco.com/).

Give 🌮 reactions to teammates in `#taqueria`. Every employee has a daily allowance (default 5). Tacos accumulate as a `balance` that can be redeemed in the [shop](#) — HR-mediated.

## What it does

- **Give by reaction**: react to a teammate's message with 🌮 → they get 1 taco.
- **Give by mention**: post `<@teammate> :taco: :taco:` in an allowlisted channel → 2 tacos to that teammate. Multi-recipient gives split the count per recipient.
- **Daily allowance**: each user gets `TACO_DAILY_ALLOWANCE` tacos to give per day, auto-reset at 00:00 UTC by a Vercel cron.
- **Two counters per user**: lifetime `received_total` (for the leaderboard) and current `balance` (redeemable).
- **DM commands**: `score`, `balance`, `left`, `shop`, `help` — English and French aliases.
- **Public shop**: `/shop` lists active items with prices, descriptions, and a "DM HR" link.
- **Admin console**: `/admin/items` (catalog CRUD with image upload), `/admin/users` (redemption form), `/admin/activity` (chronological give feed with reversal status, channel filter, and Slack deep-links), and `/admin/leaderboard` (ranked list with metric/period/channel filters). All gated by Sign in with Slack against `ADMIN_SLACK_IDS`.
- **Append-only audit log**: every give, redemption, and reversal is a row in `transactions` with the channel, message timestamp, admin, item, and reason.
- **Reversible gives**: deleting your `:taco:` message or removing your 🌮 reaction writes a compensating `type='reversal'` row, decrements the recipient's balance, restores your daily allowance (capped at the daily cap), and DMs both parties.
- **Slack-retry idempotent**: each individual taco has a unique `slack_event_id`; retries are no-ops, not duplicates. Reversals additionally key on `reversed_transaction_id` so a single give can be reversed at most once.
- **Concurrent-safe**: gives and redemptions use atomic `UPDATE … WHERE balance/daily_remaining >= N` so concurrent attempts can't overdraw.

## Quick links

- **Employees** ("how do I give and spend tacos?") → [docs/user-guide.md](docs/user-guide.md)
- **HR / shop admins** ("how do I manage items and process redemptions?") → [docs/hr-guide.md](docs/hr-guide.md)
- **Engineers** ("how is this built? how do I extend it?") → [CLAUDE.md](CLAUDE.md) and [docs/architecture.md](docs/architecture.md)
- **Operators** ("how do I deploy, run, monitor?") → continue reading, then [docs/operations.md](docs/operations.md)

## Stack

Next.js 15 + TypeScript + Tailwind on Vercel Pro · Bolt for JS (Slack Events API) · Vercel Postgres + Drizzle ORM · Auth.js v5 + Slack OIDC for the admin pages · Vitest with [pglite](https://github.com/electric-sql/pglite) for in-process integration tests.

## Prerequisites

- Vercel Pro (60s function timeout, unlimited cron jobs).
- Slack workspace admin to create the app.
- Vercel Postgres / Neon database attached to the project.

## One-time setup

### 1. Create the Slack app

See [docs/slack-setup.md](docs/slack-setup.md) for the full checklist (scopes, event subscriptions, OAuth redirect, OIDC scopes).

### 2. Configure environment variables

Copy `.env.example` to `.env.local` (for dev) or set them in Vercel project settings.

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` from app install |
| `SLACK_SIGNING_SECRET` | App's signing secret |
| `SLACK_BOT_USER_ID` | Optional; cached from `auth.test` if absent |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | For Sign in with Slack (admin) |
| `TACO_CHANNELS` | Comma-separated channel IDs where typed/reaction gives count |
| `TACO_DAILY_ALLOWANCE` | Defaults to 5 |
| `TACO_ALT_EMOJI_NAME` | Optional; custom emoji name (no colons) accepted as currency alongside `:taco:`. When set, the bot's confirmation reaction (if enabled) uses this emoji instead of `:taco:`. |
| `TACO_REACT_ON_GIVE` | Optional; if `true`, the bot adds a `:taco:` (or alt-emoji) reaction to the giver's message as a visual ack. Defaults to `false` — recommended off, since the bot's reaction is easily mistaken for an extra give. |
| `ADMIN_SLACK_IDS` | Comma-separated Slack user IDs allowed into `/admin` |
| `HR_SLACK_ID` | Optional; if set, `/shop` renders a clickable DM link to this Slack user |
| `HR_SLACK_HANDLE` | Optional; display handle (without `@`) for the `/shop` HR contact |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | Auto-set on Vercel via `VERCEL_URL` |
| `POSTGRES_URL` | Provided by the Vercel Postgres integration |
| `NEXT_PUBLIC_SHOP_URL` | Public URL of `/shop` |
| `NEXT_PUBLIC_COMPANY_NAME` | Appears in the page `<title>`; defaults to "WLT" |
| `CRON_SECRET` | Auto-injected by Vercel for cron requests |

### 3. Migrate the database

```bash
pnpm db:migrate
```

(Vercel runs this automatically as part of `pnpm build`.)

### 4. Bootstrap user list

After deployment, run once to import existing workspace members:

```bash
pnpm sync-users
```

Subsequent joiners are picked up by the `team_join` event automatically.

### 5. Invite the bot

In Slack, run `/invite @tacobot` in `#taqueria-beta` (or whichever channel(s) you set in `TACO_CHANNELS`).

## Local development

The dev container (or any local machine) needs Node 20 and pnpm. The first install requires the project's `.npmrc` setting (`store-dir=/home/node/.pnpm-store`) to avoid a copyfile race with pnpm's default project-local store on bind-mounted filesystems.

```bash
pnpm install
```

### Run the dev server

```bash
pnpm dev
```

The dev server starts fine without secrets, but the moment a route reads `config.slack.botToken` (or any required env var) it throws. Provide the values via `.env.local` before exercising the Slack webhook or admin pages.

### Tests

Integration tests run against an in-process PGlite — no Docker, no real Postgres needed locally:

```bash
pnpm test
pnpm test:watch     # watch mode
```

For the full development workflow (devcontainer, debugging, testing patterns, migration workflow, CI), see [docs/development.md](docs/development.md).

### Slack event delivery during dev

Slack must reach a public URL to deliver events. For local dev:

1. `ngrok http 3000` (or `cloudflared tunnel`).
2. Update the Slack app's Event Subscriptions URL to the ngrok URL with path `/api/slack/events`.
3. Don't forget to set the Slack app's OAuth redirect URL too if testing admin sign-in locally.

For most development, deploying to a Vercel preview branch is simpler than running locally — Vercel preview deploys are free and reachable from Slack.

## Deploying to Vercel

1. Link the project: `vercel link` from the repo, or use the Vercel dashboard "Import Git Repository" flow.
2. In Vercel → **Storage**, create a Postgres / Neon database. This auto-injects `POSTGRES_URL` and friends.
3. Set the env vars from the table above in the Vercel project settings.
4. The `vercel.json` already declares the daily-reset cron at `0 0 * * *` (UTC midnight). It appears in **Settings → Cron Jobs** after first deploy.
5. Push to the deploy branch; Vercel runs `pnpm build` (which includes `pnpm db:migrate`) and `next build`.
6. After the first deploy, run `pnpm sync-users` once locally with the production `POSTGRES_URL` set in `.env.local`, to bulk-import existing workspace members.

## Operations (quick reference)

| Action | How |
|---|---|
| Add or remove an admin | Update `ADMIN_SLACK_IDS` in Vercel env, redeploy |
| Change the channel allowlist | Update `TACO_CHANNELS`, redeploy, `/invite @tacobot` in any new channel |
| Change the daily allowance | Update `TACO_DAILY_ALLOWANCE`; the next 00:00 UTC reset refills everyone to the new value |
| Change the daily-reset timezone | Edit the cron expression in `vercel.json` (UTC; env-vars don't interpolate). Default `0 0 * * *` is UTC midnight; e.g. `0 8 * * *` = 08:00 UTC |
| Rotate Slack signing secret | Regenerate in Slack dashboard → update `SLACK_SIGNING_SECRET` in Vercel → redeploy |
| Inspect data | `pnpm db:studio` opens Drizzle Studio against the configured database |

For runbook-level detail (smoke checklist, audit-query cookbook, monitoring, failure-mode cheatsheet, manual balance correction policy), see [docs/operations.md](docs/operations.md).

## Architecture

End-to-end: Slack POSTs to `/api/slack/events` → custom `AppRouterReceiver` verifies the HMAC and short-circuits URL-verification handshakes → Bolt App dispatches to the message / reaction / command / user-sync handlers in `lib/slack/handlers/` → pure validate/decide logic in `lib/slack/give.ts` → atomic transactional execute in `lib/slack/execute.ts` → Drizzle → Postgres. Auth.js v5 with the Slack OIDC provider gates `/admin/*` (the allowlist check is in the `signIn` callback, so non-admins never get a session). A daily Vercel cron resets the allowance.

For the full system diagram, data-model rationale, give/redeem flow traces, idempotency and concurrency model, see [docs/architecture.md](docs/architecture.md).

## License

Internal use, not published.
