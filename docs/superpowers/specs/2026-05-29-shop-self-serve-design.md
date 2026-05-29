# Self-serve shop with pending orders — design

**Status:** draft
**Date:** 2026-05-29
**Author:** brainstorm w/ Claude (Opus 4.7)

## Problem

Today, users see the catalog at `/shop` but must DM HR to redeem an item; HR runs admin `Deduct` on `/admin/users` to actually move tacos. Manual, slow, asymmetric.

Goal: users redeem themselves from the shop URL. Tacos deduct atomically at purchase. A pending order is created. An admin marks the order fulfilled (or cancels & refunds). A bot posts each new order to `#tacoshop` with inline action buttons so admins can act without leaving Slack.

## Scope

In:

- Authenticated `/shop` (any active Slack user) with `Buy` buttons.
- New `orders` table with `pending → fulfilled` and `pending → cancelled` state transitions.
- Atomic purchase: stock decrement + balance debit + order insert + redeem ledger row in one transaction.
- Cancel refunds balance + restores stock; append-only via `grant` ledger row.
- Slack `#tacoshop` channel receives a Block Kit message per new order with `Mark fulfilled` and `Cancel & refund` buttons; admin-gated.
- `/admin/orders` web page with the same fulfill/cancel actions.
- Feature flag `SHOP_SELF_SERVE_ENABLED` for staged rollout.

Out:

- Buyer-initiated cancellation.
- Order history page for end users (use Slack DM with the bot, future work).
- Partial fulfillment / multi-item carts.
- Reservation/hold pattern (deduct-at-fulfill or two-phase commit).
- Admin approval gate before fulfillment.

## Decisions and rationale

| Decision | Choice | Rationale |
| --- | --- | --- |
| Auth | Slack OIDC sign-in on `/shop` for any active user | Reuses existing Auth.js + Slack provider; lowest new infra. |
| Order states | `pending`, `fulfilled`, `cancelled` | Minimal lifecycle covering cancel/refund. No `approved` middle step (YAGNI). |
| Deduction timing | At purchase (atomic) | Same proven pattern as `redeem()`; prevents oversell; cancellation refunds. |
| Stock | Decrement at purchase; restore on cancel | Matches expected behaviour of admin-set quantity caps. |
| Slack post | Block Kit msg + inline buttons in `#tacoshop` | Fast admin path; channel is already the work surface. |
| Button gate | `ADMIN_SLACK_IDS` only | Mirrors existing admin model; channel membership not sufficient. |
| Admin web UI | `/admin/orders` list + actions | Belt & suspenders alongside Slack buttons; same underlying functions. |
| Cancel semantics | Refund balance + restore stock | Append-only `grant` row; predictable. |
| Data model | New `orders` table; `transactions` keeps ledger via `orderId` FK | Clean separation: state machine vs. ledger. |
| Admin manual deduct | Keep current `/admin/users` deduct form | Offline / in-person redemption escape hatch. |
| Channel config | Required env `TACOSHOP_CHANNEL_ID` | Matches existing env pattern; fail fast if unset. |

## Architecture

### New surfaces

- `app/shop/page.tsx` — authenticated catalog. Server component reads `await auth()`; renders sign-in CTA when unauthenticated; renders `Buy` buttons + balance header when signed in. Uses server action `buyItem(formData)`.
- `app/admin/orders/page.tsx` — filterable orders table.
- `app/admin/orders/actions.ts` — `fulfillOrderAction(formData)`, `cancelOrderAction(formData)`.
- `lib/slack/handlers/orderActions.ts` — Bolt `app.action("order_fulfill", ...)` and `app.action("order_cancel", ...)` handlers.
- `/api/slack/events` — already routes Slack interactivity payloads; AppRouterReceiver may need a small tweak to handle `application/x-www-form-urlencoded` body with `payload=...` field (verify, fix if needed).

### New library modules

- `lib/shop/purchase.ts` — `purchase(db, { userId, itemId })` returns `{ kind: "ok"|"unavailable"|"insufficient"|"out_of_stock", order? }`. Atomic.
- `lib/shop/fulfill.ts` — `fulfillOrder(db, { orderId, adminId })` returns `{ kind: "ok"|"not_pending", order? }`. Atomic.
- `lib/shop/cancel.ts` — `cancelOrder(db, { orderId, adminId })` returns `{ kind: "ok"|"not_pending", order?, refundTxId? }`. Atomic.
- `lib/slack/format.ts` — extend with `orderPostedBlocks`, `orderFulfilledBlocks`, `orderCancelledBlocks`, `purchaseConfirmationDm`, `orderFulfilledDm`, `orderCancelledDm`.
- `lib/db/queries.ts` — `listOrders({ status?, userId?, itemId?, cursor?, limit })`, `getOrderById(id)`.

### Data model

#### `orders` table

```ts
orders {
  id                  uuid pk
  userId              text not null → users.id          // buyer
  itemId              uuid not null → items.id
  itemNameSnap        text not null                     // snapshot at purchase
  descriptionSnap     text                              // snapshot at purchase
  redemptionInstructionsSnap text                       // snapshot at purchase
  pricePaid           int  not null                     // snapshot at purchase
  status              text not null                     // 'pending' | 'fulfilled' | 'cancelled'
  redeemTxId          uuid → transactions.id            // set after redeem row inserted
  refundTxId          uuid → transactions.id            // set on cancel
  slackChannelId      text                              // populated when post succeeds
  slackMessageTs      text                              // populated when post succeeds
  createdAt           timestamptz not null default now()
  fulfilledAt         timestamptz
  cancelledAt         timestamptz
  fulfilledByAdminId  text → users.id
  cancelledByAdminId  text → users.id
}
CHECK status IN ('pending','fulfilled','cancelled')
CHECK pricePaid > 0
CHECK status='pending'    => fulfilledAt IS NULL AND cancelledAt IS NULL
                          AND fulfilledByAdminId IS NULL AND cancelledByAdminId IS NULL
                          AND refundTxId IS NULL
CHECK status='fulfilled'  => fulfilledAt IS NOT NULL AND fulfilledByAdminId IS NOT NULL
                          AND cancelledAt IS NULL AND cancelledByAdminId IS NULL
                          AND refundTxId IS NULL
CHECK status='cancelled'  => cancelledAt IS NOT NULL AND cancelledByAdminId IS NOT NULL
                          AND refundTxId IS NOT NULL
                          AND fulfilledAt IS NULL AND fulfilledByAdminId IS NULL
INDEX (status, createdAt)
INDEX (userId, createdAt)
INDEX (itemId, createdAt)
```

#### `transactions` table changes

Add nullable `orderId uuid → orders.id`. No backfill needed; existing rows null.

Relax `transactions_shape_and_rule` CHECK for `redeem`:

- Old: `redeem AND fromUserId IS NULL AND adminUserId IS NOT NULL AND itemId IS NOT NULL AND reversedTransactionId IS NULL`.
- New:
  - `redeem AND fromUserId IS NULL AND itemId IS NOT NULL AND reversedTransactionId IS NULL`
  - PLUS: `(orderId IS NOT NULL AND adminUserId IS NULL) OR (orderId IS NULL AND adminUserId IS NOT NULL)`.

Interpretation: shop-originated redeem rows have `orderId` set and `adminUserId NULL`; admin-originated redeem rows are the opposite. Audit semantics stay clean: `adminUserId` always means "an admin acted on behalf of someone."

Extend `grant` clause analogously to allow `orderId` set on refund grants: `grant AND fromUserId IS NULL AND adminUserId IS NOT NULL AND itemId IS NULL AND reversedTransactionId IS NULL`. (No change to other constraints; just permits `orderId` to be non-null for `grant` rows whose `reason='order cancelled'`.)

### Purchase flow

1. User signed in. Click `Buy` for item X.
2. Server action `buyItem(itemId)`:
   - `requireUserId()` from session.
   - `ensureUserExists(userId)` — paranoia; should be a no-op since `signIn` callback already inserts.
   - `purchase(db, { userId, itemId })`.
3. `purchase()` transaction:
   - `SELECT … FOR UPDATE` the item row by id where `isActive=true`. Missing → return `unavailable`.
   - If `quantity IS NOT NULL`: atomic `UPDATE items SET quantity = quantity - 1 WHERE id = ? AND quantity >= 1 RETURNING id`. 0 rows → return `out_of_stock`.
   - Atomic `UPDATE users SET balance = balance - price WHERE id = ? AND balance >= price RETURNING id`. 0 rows → return `insufficient`. (Transaction rolls back the stock decrement.)
   - `INSERT INTO orders (userId, itemId, itemNameSnap=item.name, pricePaid=item.priceTacos, status='pending', createdAt=now()) RETURNING *`.
   - `INSERT INTO transactions (type='redeem', toUserId=userId, adminUserId=NULL, itemId, amount=price, orderId, reason='self-serve shop purchase') RETURNING *`.
   - `UPDATE orders SET redeemTxId = ? WHERE id = ?`.
   - Return `{ kind: "ok", order }`.
4. Outside the transaction (best-effort):
   - `chat.postMessage` to `TACOSHOP_CHANNEL_ID` with `orderPostedBlocks(order, item, buyer)`; on success patch `orders.slackChannelId/slackMessageTs`.
   - DM buyer with `purchaseConfirmationDm`.
   - Failures logged and swallowed; order remains valid and visible in `/admin/orders`.
5. `revalidatePath("/shop")`; redirect to `/shop?ok=<orderId>`.

Error returns map to user-facing banners via `?err=<code>`.

### Fulfill flow

Triggered by Slack `Mark fulfilled` button OR `/admin/orders` action.

1. Verify admin: `body.user.id ∈ config.admin.slackIds` (Slack path) or `requireAdminId()` (web).
2. `fulfillOrder(db, { orderId, adminId })`:
   - `UPDATE orders SET status='fulfilled', fulfilledAt=now(), fulfilledByAdminId=admin WHERE id=? AND status='pending' RETURNING *`. 0 rows → `not_pending`.
3. Best-effort `chat.update` the original `#tacoshop` message with `orderFulfilledBlocks(order, admin)`.
4. Best-effort DM to buyer with `orderFulfilledDm`.

No balance/stock movement on fulfill. Idempotent: re-clicking fulfilled order returns `not_pending`; Slack handler refreshes the message to current state.

### Cancel flow

Triggered by Slack `Cancel & refund` button OR `/admin/orders` action.

1. Verify admin (same as fulfill).
2. `cancelOrder(db, { orderId, adminId })` transaction:
   - `SELECT … FOR UPDATE` order by id where `status='pending'`. Missing → `not_pending`.
   - `UPDATE users SET balance = balance + pricePaid WHERE id = order.userId`. (No conditional WHERE — refund always succeeds.)
   - If `item.quantity IS NOT NULL` for this order's item: `UPDATE items SET quantity = quantity + 1 WHERE id = item.id AND quantity IS NOT NULL`.
   - `INSERT INTO transactions (type='grant', toUserId=order.userId, adminUserId=adminId, amount=order.pricePaid, orderId=order.id, reason='order cancelled') RETURNING *`.
   - `UPDATE orders SET status='cancelled', cancelledAt=now(), cancelledByAdminId=admin, refundTxId=tx.id WHERE id=order.id`.
3. Best-effort `chat.update` with `orderCancelledBlocks(order, admin)`.
4. Best-effort DM to buyer with `orderCancelledDm`.

Invariant safety: `balance` decreased at purchase and increases by the same amount on cancel → `balance ≤ receivedTotal` holds. `receivedTotal` is untouched throughout.

### Slack Block Kit messages

`orderPostedBlocks(order, item, buyer)`:

- Section: `<@buyerId> bought *<itemName>* for *<price> 🌮*`. Optional thumbnail = `item.imageUrl`.
- Context: `Order #<id-short> · pending` + `item.redemptionInstructions` if any.
- Actions block:
  - `Mark fulfilled` — `action_id="order_fulfill"`, `value=<orderId>`, style `primary`.
  - `Cancel & refund` — `action_id="order_cancel"`, `value=<orderId>`, style `danger`, with `confirm` modal.

`orderFulfilledBlocks(order, fulfilledBy)`: same section + context `Fulfilled by <@admin> at <time>`. No actions.

`orderCancelledBlocks(order, cancelledBy)`: same section + context `Cancelled by <@admin>. <price> 🌮 refunded.` No actions.

### Bolt action handlers

`lib/slack/handlers/orderActions.ts`:

```ts
app.action("order_fulfill", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (!config.admin.slackIds.includes(body.user.id)) {
    await respond({ response_type: "ephemeral", text: "Not authorized." });
    return;
  }
  const orderId = (action as { value: string }).value;
  const result = await fulfillOrder(db, { orderId, adminId: body.user.id });
  const order = result.kind === "ok" ? result.order : await getOrderById(db, orderId);
  if (!order) return;
  await client.chat.update({
    channel: order.slackChannelId!,
    ts: order.slackMessageTs!,
    blocks: blocksFor(order),  // dispatches on order.status
    text: fallbackTextFor(order),
  });
  if (result.kind === "ok") {
    await bestEffortDm(order.userId, orderFulfilledDm(order));
  }
});

// order_cancel: same shape, calls cancelOrder, updates message, DMs buyer.
```

Registered in `lib/slack/handlers.ts` `registerAllHandlers()`.

### `/admin/orders` page

Server component. Filter form (status default `pending`, user, item, cursor). Table columns:

- When (relative date)
- Buyer (name + Slack mention)
- Item (name + price)
- Status (badge)
- Action — `Mark fulfilled` / `Cancel & refund` forms for pending; muted timestamp + actor for terminal states
- Slack — deep link to `#tacoshop` message when `slackMessageTs` is set

Server actions `fulfillOrderAction` / `cancelOrderAction` wrap the same `fulfillOrder` / `cancelOrder` functions. Best-effort `chat.update` + buyer DM on success.

Nav entry `Orders` added to `/admin` layout alongside Users / Items / Activity / Leaderboard.

### Auth changes

`lib/auth.ts`:

- `signIn` callback returns `true` if `slackUserId` is present and the user is `isActive=true` in the `users` table. No admin requirement.
  - If the user is not yet in DB, call `ensureUserExists(slackUserId, profile.name)` to insert.
- Session callback unchanged.

`app/admin/layout.tsx`:

- Add admin-allowlist redirect: if `session.slackUserId` not in `config.admin.slackIds`, redirect to `/shop` with banner.

`app/shop/page.tsx`:

- Reads session. If unauthenticated, show `Sign in with Slack` CTA → `/api/auth/signin?callbackUrl=/shop`. Catalog still visible (anonymous browse OK).
- When signed in, header shows `Signed in as <name> · Balance: N 🌮 · Sign out`; each item gets a `Buy for N 🌮` button (disabled if balance < price or out of stock).

### Feature flag

`SHOP_SELF_SERVE_ENABLED` (env, default `false`). When `false`:

- `/shop` renders the current HR-contact catalog (no sign-in CTA, no Buy buttons).
- `buyItem` server action throws `disabled`.
- `/admin/orders` page returns 404 (or hides nav link).
- Bot does not post to `#tacoshop`.

After production verification, remove the flag in a follow-up commit.

## Failure modes

| Scenario | Behaviour |
| --- | --- |
| Slack post to `#tacoshop` fails | Order still created; `slackMessageTs` null; visible in `/admin/orders`; admin acts from web. |
| Bot not invited to `#tacoshop` | `chat.postMessage` returns `not_in_channel`; same as above; ops note in setup doc. |
| `chat.update` fails after fulfill/cancel | State already changed in DB; stale Slack msg; admin can refresh via web action. |
| Concurrent purchase race (stock=1) | One UPDATE wins on `quantity >= 1`; other returns `out_of_stock`; balance refunded (rolled back) because transaction aborts before debit. |
| Concurrent purchases on insufficient balance | One UPDATE wins on `balance >= price`; other returns `insufficient`; stock decrement (if any) rolled back. |
| Double-click fulfill button | `WHERE status='pending'` guard makes second call return `not_pending`; message refreshed to fulfilled state. |
| Item deleted between catalog render and buy | `unavailable` returned; user sees error banner. |
| Item price changed between catalog render and buy | The transaction reads `items.priceTacos` inside the purchase tx, so the buyer is charged the CURRENT price (which may differ from the catalog they saw). That `priceTacos` is then snapshotted into `orders.pricePaid` so later admin edits don't rewrite history. UX: rarely matters; if needed later, add a client-side price hash check (out of scope v1). |
| User signed out mid-flow | Server action throws `unauthenticated`; client redirects to sign-in. |
| Auth.js session for inactive user | `signIn` callback rejects; user must re-sync (admin runs `pnpm sync-users`). |

## Testing strategy

### Unit

- `tests/unit/format-orders.test.ts` — block kit snapshots for posted/fulfilled/cancelled blocks; DM string assertions.
- `tests/unit/auth-signin.test.ts` — `signIn` callback: active user → `true`; inactive → `false`; missing id → `false`. Stub `ensureUserExists`.

### Integration (PGlite)

- `tests/integration/purchase.test.ts`
  - happy path: balance + stock decrement, order + redeem tx inserted, order.redeemTxId set.
  - insufficient balance: no row changes.
  - out of stock (sequential): one ok, next out_of_stock.
  - inactive item: unavailable.
  - null-quantity item: ok, quantity stays null.
- `tests/integration/purchase-concurrent.test.ts` (`withCleanDb`)
  - stock=1, two parallel purchases → one ok, one out_of_stock; balance only debited once.
  - balance=N, price=N, two parallel purchases → one ok, one insufficient.
- `tests/integration/fulfill.test.ts`
  - pending → fulfilled.
  - double-fulfill → second `not_pending`.
  - fulfilled → cancel rejected.
- `tests/integration/cancel.test.ts`
  - pending → cancelled, balance restored, stock restored, refund grant tx inserted with orderId.
  - null-quantity item: stock stays null.
  - cancelled → fulfill rejected.
  - double-cancel rejected.
  - `balance ≤ receivedTotal` invariant survives.
- `tests/integration/order-actions-slack.test.ts` — mock Bolt client; simulate block_actions:
  - admin clicks fulfill → state changes, `chat.update` called with fulfilled blocks, buyer DM sent.
  - non-admin clicks fulfill → ephemeral "Not authorized", state unchanged.
  - admin clicks cancel on already-fulfilled order → ephemeral msg, `chat.update` refresh.
- `tests/integration/admin-orders-actions.test.ts` — web server actions: admin gate, fulfill/cancel paths, error mapping.

### Manual smoke (added to `docs/operations.md`)

1. Sign in as non-admin on `/shop`, observe catalog with Buy buttons.
2. Buy an item; observe success banner; verify `#tacoshop` message with two buttons.
3. As admin, click `Mark fulfilled`; observe Slack message update + DM.
4. Buy another; click `Cancel & refund`; observe balance refund + DM.

## Documentation

- New `docs/shop-self-serve.md` — sequence diagram (browser → server action → DB → Slack), state machine, failure modes table.
- `CLAUDE.md` updates:
  - Add `orders` table to invariants list (state machine, refund mechanics, snapshot fields).
  - Add new file paths to repo layout.
  - Add new entries in "Where things live" table (add a shop-order field, change order Slack msg, change cancel rules).
  - Add `SHOP_SELF_SERVE_ENABLED`, `TACOSHOP_CHANNEL_ID` to env discussion.
  - Wrinkle: redeem rows are either admin-originated (adminUserId set, orderId null) OR shop-originated (adminUserId null, orderId set).
- `docs/slack-setup.md` — enable Interactivity & Shortcuts; Request URL = `/api/slack/events`; invite bot to `#tacoshop`.
- `README.md` — env table rows; user-facing blurb about self-serve shop.
- `.env.example` — new vars with comments.

## Migration plan

1. PR 1: schema + library functions + tests, feature-flagged off.
   - `lib/db/schema.ts` adds `orders` table and `orderId` column on transactions; relax `transactions_shape_and_rule`.
   - `pnpm db:generate` → commit migration files under `drizzle/`.
   - `lib/shop/{purchase,fulfill,cancel}.ts` + tests.
   - Slack handler + format functions + tests.
   - Web pages + server actions, gated by `SHOP_SELF_SERVE_ENABLED`.
   - Auth gate change: non-admins admitted (no behaviour change when flag off — they have nowhere to go but `/shop`, which still hides Buy buttons).
2. Deploy with flag off. Confirm existing functionality unchanged.
3. Configure `TACOSHOP_CHANNEL_ID`. Invite bot to channel. Enable Interactivity. Flip flag on for a small test admin set (e.g., via short-circuit `if user in TEST_ALLOWLIST`) OR just enable for everyone and watch logs — Tacobot is small enough that staged rollout per user is overkill.
4. PR 2: remove feature flag once stable (1–2 weeks of observed traffic).

## Open questions

- Does `AppRouterReceiver` already parse Slack interactivity payloads (`Content-Type: application/x-www-form-urlencoded`, `payload=<JSON>`)? Need to verify on first implementation pass; tweak receiver if not.
- Does the bot need `chat:write.public` to post to `#tacoshop` without explicit invite, or do we mandate `/invite @tacobot`? Default to mandate invite (lower scope) and document.
(none open — resolved during self-review.)
