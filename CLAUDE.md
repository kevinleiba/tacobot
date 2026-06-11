# CLAUDE.md

Guidance for Claude Code (and human contributors) working on Tacobot. Keep this file accurate; an outdated CLAUDE.md is worse than none.

## What this is

Tacobot is a Slack `:taco:` recognition bot with an admin shop. Users react with 🌮 (or post `<@user> :taco: :taco:`) in allowlisted channels; recipients accumulate a `balance` they spend in `/shop` via HR-mediated redemption. Daily allowance resets at 00:00 UTC.

**Stack:** Next.js 15 (App Router) + TypeScript + Tailwind on Vercel · `@slack/bolt` v4 with a custom App-Router receiver · Vercel Postgres + Drizzle ORM · Auth.js v5 with Slack OIDC for `/admin` · Vitest with `@electric-sql/pglite` for in-process integration tests · Node 20, pnpm 9.

User-facing overview lives in `README.md`. Architectural deep-dive lives in `docs/architecture.md`.

## Repo layout

```
app/
  layout.tsx                       Root layout, metadata, favicons
  page.tsx                         Landing
  shop/page.tsx                    Catalog. Anonymous + signed-in views; Buy buttons + Your-pending-orders panel when SHOP_SELF_SERVE_ENABLED
  shop/actions.ts                  buyItem (purchase + post to #tacoshop) and cancelMyOrder (buyer self-cancel)
  admin/layout.tsx                 Auth gate: signin if unauthenticated, /shop redirect if not in ADMIN_SLACK_IDS
  admin/page.tsx                   Admin home
  admin/users/{page,actions}.tsx   User table + redemption form (deductTacos) + signed-balance adjustment (adjustTacos)
  admin/users/AdjustForm.tsx       Client component: window.confirm() gate around the Adjust form
  admin/items/{page,actions}.tsx   Items CRUD + Vercel Blob upload
  admin/activity/page.tsx          Chronological feed of give events with reversal status, channel filter, cursor pagination
  admin/leaderboard/page.tsx       Ranked list of givers/receivers with metric (received/given/combined), period, and channel filters
  admin/orders/{page,actions}.tsx  Order list (filter by status) + Fulfill / Cancel admin actions
  api/auth/[...nextauth]/route.ts  Auth.js handlers
  api/slack/events/route.ts        Bolt webhook: getReceiver().handle(req) — also handles interactivity payloads (form-urlencoded)
  api/cron/reset-allowance/        Daily reset; verified via Bearer ${CRON_SECRET}

lib/
  config.ts                        Lazy env-var getters (see Invariants)
  auth.ts                          NextAuth + Slack OIDC; admits any active user (admin allowlist enforced in /admin/layout)
  db/
    client.ts                      Drizzle client over @vercel/postgres
    schema.ts                      users, items, transactions, orders; CHECK constraints
    queries.ts                     upsertUser, ensureUserExists, listActiveItems, getLeaderboard, listOrders, getOrderById
    types.ts                       DbLike (Postgres / pglite-compatible)
  shop/
    types.ts                       Actor = { kind: "admin"|"buyer"; userId }
    purchase.ts                    Atomic purchase() — FOR UPDATE item, stock+balance decrement, order+redeem insert
    fulfill.ts                     fulfillOrder() — pending→fulfilled, idempotent via WHERE status='pending'
    cancel.ts                      cancelOrder() — pending→cancelled with refund grant; supports admin and buyer actors
  slack/
    bolt.ts                        Lazy singleton App + Receiver factories
    receiver.ts                    AppRouterReceiver: HMAC verify, URL handshake, JSON + form-urlencoded payload decoding
    handlers.ts                    registerAllHandlers() — wires the five below
    handlers/message.ts            Channel `:taco:` mention → give; `message_deleted` → reverse all gives on that message
    handlers/reaction.ts           `reaction_added` → 1-taco give; `reaction_removed` → reverse the reactor's give(s)
    handlers/commands.ts           App mentions + DMs: score/balance/left/shop/help
    handlers/userSync.ts           team_join + user_change → upsert/deactivate
    handlers/orderActions.ts       order_fulfill / order_cancel block_actions — admin-gated, updates #tacoshop message + DMs buyer
    give.ts                        validate() + decide() — pure domain logic
    execute.ts                     executeGive() — transactional with idempotency
    reverse.ts                     executeMessageReversal() / executeReactionReversal() — append-only compensation
    parser.ts                      countTacos, findUserIds
    format.ts                      Slack message strings + order block-kit + order DM strings
    channelInfo.ts                 resolveChannelName with 1h TTL + in-flight dedup
    userInfo.ts                    resolveUserName with 1h TTL + in-flight dedup
    botUserId.ts                   getBotUserId() singleton
  admin/redeem.ts                  redeem() — transactional balance deduction
  admin/grant.ts                   grant() — admin-issued signed balance adjustment (onboarding / normalization)
  date.ts                          formatDayHeading, formatTimeOfDay, localDayKey, periodStart (ISO Monday weeks, UTC boundaries)

drizzle/                           Generated migrations (commit them)
scripts/sync-users.ts              One-shot bootstrap from Slack users.list
scripts/zero-balances.ts           One-shot GA reset: zero every user's balance via signed grants (DRY_RUN=1 to preview)
tests/unit/                        Pure-logic tests (parser, format, decide, validate, receiver-verify)
tests/integration/                 PGlite tests (constraints, execute, redemption, reaction, cron, command-score)
tests/integration/helpers/db.ts    getDb(), inRollbackTx(), withCleanDb()
.github/workflows/ci.yml           typecheck + lint + test on push/PR
vercel.json                        Cron: `0 0 * * *` → /api/cron/reset-allowance
```

## Commands

```bash
pnpm install
pnpm dev                 # Next dev server on :3000
pnpm build               # runs `db:migrate` then `next build`
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint .
pnpm test                # vitest run
pnpm test:watch          # watch mode
pnpm db:generate         # drizzle-kit generate (after schema edits)
pnpm db:migrate          # drizzle-kit migrate
pnpm db:studio           # drizzle-kit studio (web UI)
pnpm sync-users          # bootstrap users from Slack workspace
pnpm zero-balances       # one-shot GA reset; needs RESET_ADMIN_SLACK_ID, supports DRY_RUN=1
```

CI runs `typecheck && lint && test` on every push and PR. Always run those locally before claiming done.

## Critical invariants

These are load-bearing. Don't paper over them — fix the underlying issue.

- **Lazy env validation** (`lib/config.ts`). Properties are getters; reading them throws if the env var is missing. This lets `next build` import route modules without secrets. Never access env at module-top scope; always go through `config.*`.
- **Lazy Bolt singletons** (`lib/slack/bolt.ts`). `getReceiver()` and `getBoltApp()` memoize. `next build` must not require Slack secrets.
- **`processBeforeResponse: true`** is set on the Bolt App (FaaS-correct on Vercel — the function stays alive until handlers finish). Slack's 3-second ack still applies to total handler runtime; budget <500ms per event.
- **URL-verification short-circuits** before Bolt dispatch in `lib/slack/receiver.ts`. Don't move signature-verify around it.
- **HMAC-SHA256 signature verify** with a 5-minute replay window and `crypto.timingSafeEqual` (`lib/slack/receiver.ts:84`). The receiver reads the raw body via `req.text()` — never `req.json()` first, or the signature won't match.
- **Atomic give** (`lib/slack/execute.ts:20`): `UPDATE users SET dailyRemaining = dailyRemaining - N WHERE id = … AND dailyRemaining >= N RETURNING id`. If the UPDATE returns 0 rows, the transaction rolls back as `over_allowance`. Never read-then-write.
- **Atomic redeem** (`lib/admin/redeem.ts:17`): same pattern on `balance`. The atomic `WHERE balance >= amount` (not a DB CHECK — `balance >= 0` was relaxed) is what prevents overdraw on redemption.
- **Append-only reversals** (`lib/slack/reverse.ts`): undoing a give writes a `type='reversal'` row referencing the original via `reversed_transaction_id` (UNIQUE). Counters update too: recipient's `balance`/`receivedTotal` decrement (allowed to go negative), giver's `daily_remaining` is restored capped at `dailyAllowance`. Never UPDATE/DELETE existing transactions — always insert compensation.
- **Idempotency**: each individual taco is its own `transactions` row keyed by `slack_event_id`. Composite forms: `${envelopeEventId}-${idx}` for messages, `react-${channel}-${ts}-${reactor}-${idx}` for reactions, `delete-${original.id}` / `unreact-${original.id}` for reversals. The UNIQUE constraint + `onConflictDoNothing` makes Slack retries safe; for gives, if any insert returns 0 rows the whole give rolls back as `duplicate`. For reversals, per-row `onConflictDoNothing` on `reversed_transaction_id` lets a partial run resume cleanly.
- **DB CHECK constraints** (`lib/db/schema.ts`): `dailyRemaining >= 0`, `balance <= receivedTotal`, `priceTacos > 0`, `quantity >= 0 OR NULL` (zero means "sold out, item still active so cancel can restore stock"), unique `lower(name)` among active items, four-way row shape with discriminator columns (give: `fromUserId` set, no admin/item/order/reversal-ref, no self-give; redeem: `itemId` set, no `fromUserId`/reversal-ref, AND exactly one of `adminUserId` (admin-deducted) or `orderId` (self-serve) — the two are mutually exclusive; reversal: only `toUserId` and `reversedTransactionId` set, plus UNIQUE on `reversedTransactionId` to block double-reversal; grant: `fromUserId`/`itemId`/reversal-ref null, AND either `adminUserId` set with `orderId` null (onboarding/normalization) OR `orderId` set with optional `adminUserId` (refund grant: admin-cancel sets both, buyer self-cancel leaves `adminUserId` null)). The amount CHECK is type-conditional: `give`/`redeem`/`reversal` require `amount > 0`, but `grant` only requires `amount <> 0` so admins can issue negative adjustments. `balance` and `receivedTotal` *may* be negative — they decrement together when a give is reversed after the recipient has already redeemed, or when an admin grants a negative amount. Don't bypass with raw SQL.
- **`orders` state machine** (`lib/db/schema.ts`): three statuses (`pending`, `fulfilled`, `cancelled`) with a CHECK that enforces shape per state — `pending` has no terminal timestamps or admin/refund refs; `fulfilled` requires `fulfilledAt` + `fulfilledByAdminId`; `cancelled` requires `cancelledAt` + `refundTxId`, with `cancelledByAdminId` nullable so buyer self-cancel is legal. Snapshot fields `itemNameSnap`, `descriptionSnap`, `redemptionInstructionsSnap`, `pricePaid` are frozen at purchase time so later item edits don't rewrite history. Transitions are owned by `lib/shop/purchase.ts` (insert pending), `lib/shop/fulfill.ts` (pending → fulfilled, atomic on `WHERE status='pending'`), `lib/shop/cancel.ts` (pending → cancelled with refund + stock restore). Never mutate orders directly — use these or you'll skip the ledger row + counters update.
- **Self-serve purchase atomicity** (`lib/shop/purchase.ts`): single `db.transaction` with `FOR UPDATE` on the item row, conditional `UPDATE … WHERE quantity >= 1` for stock and `UPDATE … WHERE balance >= price` for funds, then insert order + redeem-tx + patch `orders.redeemTxId`. Failures throw a `PurchaseAbort` sentinel so the whole tx rolls back; the outer catch maps it to `{ kind: "out_of_stock" | "insufficient" | "unavailable" }`. Returning a typed value from inside the tx callback would COMMIT partial writes — always throw to roll back.
- **Cancel-refund mechanics** (`lib/shop/cancel.ts`): refund only touches `users.balance` (not `receivedTotal`) — purchase decremented `balance` and left `receivedTotal` alone, so cancel's `balance += pricePaid` restores the pre-purchase state and the `balance <= receivedTotal` invariant survives. Refund inserts a `type='grant'` row with `orderId` set; `adminUserId` is the admin slack id on admin-cancel and `NULL` on buyer self-cancel (the discriminator in the relaxed `shape_and_rule` CHECK). The existing `lib/admin/grant.ts` adjusts BOTH `balance` and `receivedTotal` — don't reuse it for refunds.
- **Auth gate split**: `lib/auth.ts` `signIn` callback admits any active user (and auto-inserts on first sign-in via `onConflictDoUpdate`). The admin allowlist gate lives in `app/admin/layout.tsx` — non-admins get a session and `/shop` access, but `/admin/*` redirects them to `/shop?err=admin_only`. The admin layout still redirects unauthenticated visitors to `/api/auth/signin?callbackUrl=/admin`.
- **User-name freshness** (`lib/slack/userInfo.ts`): 1-hour TTL cache + in-flight dedup. Score/leaderboard renders `<@USERID>` mentions so Slack handles current display name + avatar — we never have to re-render the cached name.
- **Currency emoji set** (`lib/config.ts` → `taco.acceptedEmojis`): `:taco:` is always accepted. If `TACO_ALT_EMOJI_NAME` is set, that custom emoji is *additionally* accepted for both typed mentions and reactions. Read this set via `config.taco.acceptedEmojis` / `config.taco.confirmationEmojiName` — don't hardcode `"taco"` in handlers. The bot's confirmation reaction (`reactions.add`) is gated by `config.taco.reactOnGive` (env `TACO_REACT_ON_GIVE`, default `false`) — `confirmationEmojiName` is only consulted when that flag is on. **Bot message prose** (over-allowance, message/reaction-deleted DMs, grant DMs, leaderboard/help banner) also uses `config.taco.confirmationEmojiName` as its leading branding shortcode, passed in by callers — `lib/slack/format.ts` stays config-free. Reaction-removed DMs echo `event.reaction` (the actual emoji removed), not the configured one, so the user sees what they did. The instructional `:taco:` in the help text is intentionally literal because `:taco:` is always in the accepted set.

## Conventions

- TypeScript strict, ESM, Next.js App Router. React 19 server components by default; opt into `"use client"` only when you need it.
- Drizzle queries belong in `lib/db/queries.ts`; don't scatter ORM calls across handlers.
- Slack handlers belong in `lib/slack/handlers/`. Pure logic (validate, decide, parse, format) belongs in sibling files and stays unit-testable.
- Tests: unit under `tests/unit/`, integration under `tests/integration/` using PGlite. `inRollbackTx` (per-test SAVEPOINT) is the default; use `withCleanDb` only when a test needs multiple connections.
- Prettier (`.prettierrc`): `semi: true`, double quotes, trailing-comma `all`, 100 cols, 2-space indent. ESLint flat config in `eslint.config.mjs`.
- Commit messages match the existing repo style: lower-case `type(scope): summary` (e.g. `feat(items): quantity, redemption instructions, image upload`).

## Common gotchas

- Don't add a second daily-allowance source — read `config.taco.dailyAllowance` only.
- Don't bypass `validate()` → `decide()` → `executeGive()`. The chain encodes channel allowlist, dedup, self-give filter, and atomicity. Same shape for reactions in `lib/slack/handlers/reaction.ts:processReaction`.
- Don't `req.json()` before HMAC verify — JSON parse can canonicalize whitespace/key order and break the signature.
- Adding a new env var means three edits: a getter in `lib/config.ts`, a row in `.env.example` (with comment), and a row in the README env table.
- Adding a DB column means: edit `lib/db/schema.ts`, run `pnpm db:generate`, commit the new file under `drizzle/`. Never edit a migration after merge.
- The Vercel cron expression in `vercel.json` doesn't interpolate env vars. Timezone changes are file-edit + redeploy.
- The cron route accepts both POST and GET (Vercel's behaviour varies). Both verify `Authorization: Bearer ${CRON_SECRET}`.
- The reaction handler resolves the message author via `conversations.history` (the `reaction_added` payload doesn't include it). Failure there silently drops the event.
- Slack types `event` as a discriminated union — narrow with `if ("user" in event)` / `event.subtype === …` rather than casting.
- **Re-react after unreact is silently ignored.** A reaction's give uses `slack_event_id = react-${channel}-${ts}-${reactor}-${idx}`, so removing then re-adding the same reaction tries to INSERT the identical key and `onConflictDoNothing` no-ops. The original give is permanently reversed; the new reaction has no effect. Pre-existing limitation; matches the same key collision that protects against Slack retries.
- **Adding `reaction_removed` (or any new event)** means subscribing to it in the Slack app dashboard (`docs/slack-setup.md`) — not just registering it in `lib/slack/handlers.ts`.
- **`message_deleted` reverses across the full message scope**, including `:taco:` reactions left by other people. The reactors are notified by DM. This matches Slack's own behavior (their reactions disappear with the message).
- **Switching `TACO_ALT_EMOJI_NAME` between deploys does NOT touch historical gives.** Existing transactions remain valid; only future events are affected by the new accepted-emoji set. The reaction-removed DM echoes whichever emoji was actually removed (we read `event.reaction`), so reversing an old `:taco:` give still says `:taco:` even after switching the alt emoji.

## Where things live for common tasks

| Task | File(s) |
| --- | --- |
| Add a DM/mention command | `lib/slack/handlers/commands.ts` (regex + `dispatch()`) |
| Change give/over-allowance message wording | `lib/slack/format.ts` |
| Add a shop-item field | `lib/db/schema.ts` → `pnpm db:generate` → `app/admin/items/{page,actions}.tsx` → `app/shop/page.tsx` |
| Change daily-reset time | `vercel.json` cron expression |
| Change give/redeem rules | `lib/slack/give.ts` + `lib/slack/execute.ts` (or `lib/admin/redeem.ts`) |
| Add/correct a user's balance from admin panel | `app/admin/users/{page,actions,AdjustForm}.tsx` + `lib/admin/grant.ts` |
| Change reversal rules (delete/unreact) | `lib/slack/reverse.ts` + handlers in `lib/slack/handlers/{message,reaction}.ts` |
| Change self-serve purchase rules | `lib/shop/purchase.ts` (+ `app/shop/actions.ts` for UX) |
| Change fulfill/cancel rules | `lib/shop/{fulfill,cancel}.ts` (+ Slack handler in `lib/slack/handlers/orderActions.ts`, web actions in `app/admin/orders/actions.ts`, buyer action in `app/shop/actions.ts`) |
| Change the #tacoshop announcement / state-change block kit | `lib/slack/format.ts` (`orderPostedBlocks` / `orderFulfilledBlocks` / `orderCancelledBlocks`) |
| Bootstrap users from Slack | `pnpm sync-users` (`scripts/sync-users.ts`) |
| Add an admin | env: `ADMIN_SLACK_IDS` (comma-separated Slack IDs) + redeploy |
| Flip self-serve shop on/off | env: `SHOP_SELF_SERVE_ENABLED` (default `false`); requires `TACOSHOP_CHANNEL_ID` when on |
| Add the HR contact link to `/shop` (legacy, retired by self-serve) | env: `HR_SLACK_ID` + `HR_SLACK_HANDLE` |
| Channel allowlist | env: `TACO_CHANNELS` |

For a deeper map (data flow, idempotency, concurrency model), see `docs/architecture.md`. For the operator runbook (deploy, audit queries, smoke tests), see `docs/operations.md`. For local-dev specifics (devcontainer, ngrok, testing patterns), see `docs/development.md`.
