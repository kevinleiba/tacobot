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
- Buyer self-cancel of own pending orders from `/shop` (web only; no Slack button).
- Replace existing HR-DM contact line on `/shop` with a `#tacoshop` channel link as the async fallback path.
- Feature flag `SHOP_SELF_SERVE_ENABLED` for staged rollout.

Out:

- Order history page for end users beyond pending orders (full history page is future work; use Slack DM with the bot for v1).
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
| Buyer self-cancel | Allowed while `status='pending'`, web only (`/shop`) | Same `cancelOrder()` core; gate on `actor.userId === order.userId`; no Slack-side button needed. |
| Async fallback on `/shop` | Replace HR-DM line with `#tacoshop` channel link | One canonical async path; admins already watch the channel for self-serve orders. HR contact retires from this surface. |
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
- `lib/shop/cancel.ts` — `cancelOrder(db, { orderId, actor })` where `actor: { kind: "admin"|"buyer", userId: string }`. Returns `{ kind: "ok"|"not_pending", order?, refundTxId? }`. Atomic. Caller is responsible for authorising the actor; the function trusts the `actor` arg.
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
CHECK status='cancelled'  => cancelledAt IS NOT NULL AND refundTxId IS NOT NULL
                          AND fulfilledAt IS NULL AND fulfilledByAdminId IS NULL
                          -- cancelledByAdminId NULL means buyer self-cancelled
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

Extend `grant` clause to also cover refund grants and to allow `adminUserId NULL` for buyer self-cancels:

- New `grant` clause: `grant AND fromUserId IS NULL AND itemId IS NULL AND reversedTransactionId IS NULL`
  - PLUS: `(adminUserId IS NOT NULL AND orderId IS NULL) OR (orderId IS NOT NULL)`.

Interpretation: admin-issued grant (onboarding/normalisation) has `adminUserId` set and `orderId` null. Refund grants linked to a cancelled order set `orderId`; `adminUserId` is set when an admin cancelled, NULL when the buyer self-cancelled. Same audit semantics as redeem rows: `adminUserId IS NULL` means the actor was the affected user themselves.

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

Triggered by:

- Admin: Slack `Cancel & refund` button OR `/admin/orders` action. Authorise by admin allowlist.
- Buyer: `/shop` "Cancel" button on a pending order in their own "Your pending orders" panel. Authorise by `session.slackUserId === order.userId`.

Both paths funnel into the same `cancelOrder(db, { orderId, actor })`:

1. Caller authorises and constructs `actor = { kind: "admin"|"buyer", userId }`.
2. `cancelOrder()` transaction:
   - `SELECT … FOR UPDATE` order by id where `status='pending'`. Missing → `not_pending`.
   - Defensive: when `actor.kind === "buyer"`, additionally require `order.userId === actor.userId`. (Outer auth already checks this; the inner check is belt + suspenders.)
   - `UPDATE users SET balance = balance + pricePaid WHERE id = order.userId`. (No conditional WHERE — refund always succeeds.)
   - If `item.quantity IS NOT NULL` for this order's item: `UPDATE items SET quantity = quantity + 1 WHERE id = item.id AND quantity IS NOT NULL`.
   - `INSERT INTO transactions (type='grant', toUserId=order.userId, adminUserId = actor.kind==='admin' ? actor.userId : NULL, amount=order.pricePaid, orderId=order.id, reason = actor.kind==='admin' ? 'order cancelled by admin' : 'order cancelled by buyer') RETURNING *`.
   - `UPDATE orders SET status='cancelled', cancelledAt=now(), cancelledByAdminId = actor.kind==='admin' ? actor.userId : NULL, refundTxId=tx.id WHERE id=order.id`.
3. Best-effort `chat.update` with `orderCancelledBlocks(order, actor)`.
4. Best-effort DM to buyer with `orderCancelledDm`. (Self-cancel still DMs — confirms refund and serves as cross-device receipt.)

Note: `cancelledByAdminId` is null on self-cancel. The previously documented CHECK `status='cancelled' => cancelledByAdminId IS NOT NULL` is relaxed accordingly; see *Schema constraints (updated)* below.

Invariant safety: `balance` decreased at purchase and increases by the same amount on cancel → `balance ≤ receivedTotal` holds. `receivedTotal` is untouched throughout.

#### Schema constraints (updated)

The `orders` CHECK for the `cancelled` state becomes:

```
CHECK status='cancelled' => cancelledAt IS NOT NULL
                         AND refundTxId IS NOT NULL
                         AND fulfilledAt IS NULL
                         AND fulfilledByAdminId IS NULL
```

`cancelledByAdminId` is no longer required to be non-null; it remains a nullable FK that distinguishes admin-cancel from buyer-self-cancel.

### Slack Block Kit messages

`orderPostedBlocks(order, item, buyer)`:

- Section: `<@buyerId> bought *<itemName>* for *<price> 🌮*`. Optional thumbnail = `item.imageUrl`.
- Context: `Order #<id-short> · pending` + `item.redemptionInstructions` if any.
- Actions block:
  - `Mark fulfilled` — `action_id="order_fulfill"`, `value=<orderId>`, style `primary`.
  - `Cancel & refund` — `action_id="order_cancel"`, `value=<orderId>`, style `danger`, with `confirm` modal.

`orderFulfilledBlocks(order, fulfilledBy)`: same section + context `Fulfilled by <@admin> at <time>`. No actions.

`orderCancelledBlocks(order, actor)`: same section + context. When `actor.kind==='admin'`: `Cancelled by <@admin>. <price> 🌮 refunded.` When `actor.kind==='buyer'`: `Cancelled by buyer. <price> 🌮 refunded.` No actions.

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
  // (Slack-button cancel uses the admin variant: `cancelOrder(db, { orderId, actor: { kind: "admin", userId: body.user.id } })`.)
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

Server actions `fulfillOrderAction` / `cancelOrderAction` wrap the same `fulfillOrder` / `cancelOrder` functions. `cancelOrderAction` calls `cancelOrder(db, { orderId, actor: { kind: "admin", userId: adminId } })`. Best-effort `chat.update` + buyer DM on success.

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
- Above the catalog (signed-in only), a `Your pending orders` panel lists this buyer's orders where `status='pending'`. Each row: item name + price + age + `Cancel` button (uses native `<form>` with `window.confirm()` gate). Submits server action `cancelMyOrder(formData)`. Panel hidden when empty.
- Header copy on `/shop` advertises the alternative async path: replace the existing `DM @HR to redeem` line with `Prefer Slack? Post your order in #tacoshop`. The link uses Slack's `slack://channel?team={teamId}&id={TACOSHOP_CHANNEL_ID}` deep-link format with an HTTPS fallback `https://slack.com/app_redirect?channel={TACOSHOP_CHANNEL_ID}` so it opens reliably from both desktop and web Slack. The current HR contact line (and the `HR_SLACK_ID` / `HR_SLACK_HANDLE` env vars in this surface) is removed — `#tacoshop` is now the single canonical async fallback.
  - Anonymous viewers also see this line (no auth required to read it; clicking opens Slack).
  - Slack workspace deep-link team id: prefer not to hardcode. If we don't have `team_id` in config, omit the `slack://` URL and use only the `slack.com/app_redirect` form, which works without a team id.
  - Channel name (text) defaults to `#tacoshop`. If you ever rename the channel, swap the literal in `lib/slack/format.ts` (web copy helper) — channel id stays the same in `TACOSHOP_CHANNEL_ID`.

### Server action `cancelMyOrder(orderId)`

1. `requireUserId()` from session.
2. Load order. If missing OR `order.userId !== sessionUserId` OR `order.status !== 'pending'` → throw friendly error mapped to `/shop?err=<code>`.
3. Call `cancelOrder(db, { orderId, actor: { kind: "buyer", userId: sessionUserId } })`.
4. Best-effort `chat.update` to `#tacoshop` msg (if `slackMessageTs` set) with `orderCancelledBlocks(order, actor)`.
5. Best-effort DM to buyer with self-cancel confirmation copy.
6. `revalidatePath("/shop")`; redirect to `/shop?cancelled=<orderId>`.

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
| Buyer cancels at the same moment admin fulfills/cancels | Both routes hit the `status='pending'` guard inside `cancelOrder`/`fulfillOrder`; whichever transaction commits first wins. The loser receives `not_pending` and surfaces the current state to its UI. |
| Buyer tries to cancel another user's order via crafted form | Server action denies via `order.userId !== sessionUserId`; defensive inner check in `cancelOrder` also rejects. State unchanged. |
| Item deleted between catalog render and buy | `unavailable` returned; user sees error banner. |
| Item price changed between catalog render and buy | The transaction reads `items.priceTacos` inside the purchase tx, so the buyer is charged the CURRENT price (which may differ from the catalog they saw). That `priceTacos` is then snapshotted into `orders.pricePaid` so later admin edits don't rewrite history. UX: rarely matters; if needed later, add a client-side price hash check (out of scope v1). |
| User signed out mid-flow | Server action throws `unauthenticated`; client redirects to sign-in. |
| Auth.js session for inactive user | `signIn` callback rejects; user must re-sync (admin runs `pnpm sync-users`). |

## Testing strategy

### Unit

- `tests/unit/format-orders.test.ts`
  - posted blocks: buyer mention, item name, price, two action buttons present with correct `action_id` + `value=<orderId>`, `confirm` payload on cancel button.
  - fulfilled blocks: no action buttons, `Fulfilled by <@admin>` context line, timestamp present.
  - cancelled blocks: admin variant `Cancelled by <@admin>` and buyer variant `Cancelled by buyer`; refund amount rendered.
  - fallback text: posted/fulfilled/cancelled `text` field for Slack notifications stays accurate (Slack uses it for push and accessibility).
  - DM strings: purchase confirmation includes item + price + balance hint; fulfilled DM names admin; cancelled DM differentiates admin-cancel vs self-cancel.
  - Currency emoji branding obeys `config.taco.confirmationEmojiName` (so blocks render correctly when `TACO_ALT_EMOJI_NAME` is set).
- `tests/unit/auth-signin.test.ts`
  - `signIn` callback: active user in DB → `true`.
  - inactive user in DB → `false`.
  - missing slack id in profile → `false`.
  - admin id (which is also active) → `true`.
  - user not yet in DB → `ensureUserExists` invoked (mocked) with `(slackId, profile.name)`, callback returns `true`.

### Integration (PGlite)

- `tests/integration/schema-constraints-orders.test.ts` — direct INSERTs to verify each new/changed CHECK. PGlite raises Postgres CHECK violations the same as production.
  - `orders` row with `status='pending'` and `fulfilledAt` set → CHECK violation.
  - `orders` row with `status='fulfilled'` and `fulfilledByAdminId IS NULL` → CHECK violation.
  - `orders` row with `status='cancelled'` and `refundTxId IS NULL` → CHECK violation.
  - `orders` row with `status='cancelled'`, `cancelledByAdminId IS NULL`, `refundTxId` set → CHECK passes (self-cancel shape).
  - `orders` row with `pricePaid <= 0` → CHECK violation.
- `tests/integration/schema-constraints-transactions.test.ts` — CHECKs on relaxed `shape_and_rule` for redeem + grant.
  - `redeem` with `adminUserId IS NULL` and `orderId IS NULL` → violation.
  - `redeem` with `adminUserId IS NULL` and `orderId` set → passes (shop-originated).
  - `redeem` with `adminUserId` set and `orderId IS NULL` → passes (admin-deducted).
  - `redeem` with both `adminUserId` AND `orderId` set → violation (mutually exclusive).
  - `grant` with `adminUserId` set and `orderId IS NULL` → passes (onboarding/normalisation).
  - `grant` with `adminUserId IS NULL` and `orderId` set → passes (buyer self-cancel refund).
  - `grant` with `adminUserId` set and `orderId` set → passes (admin cancel refund).
  - `grant` with both `adminUserId IS NULL` and `orderId IS NULL` → violation.
  - existing `grant` with non-zero `amount` (positive AND negative) still passes.
- `tests/integration/purchase.test.ts`
  - happy path: `balance -= price`, `quantity -= 1`, order row inserted with `status='pending'` + snapshots (`itemNameSnap`, `descriptionSnap`, `redemptionInstructionsSnap`, `pricePaid`), redeem tx inserted with `orderId` + `adminUserId IS NULL`, `order.redeemTxId` patched.
  - boundary: `balance === priceTacos` → ok, balance ends at 0.
  - `balance === 0` → `insufficient`, no row changes anywhere.
  - insufficient balance (general): no row changes (assert users, items, orders, transactions counts unchanged).
  - out of stock (sequential): first ok, second `out_of_stock`, second's balance debit rolled back (assert balance unchanged for second buyer).
  - inactive item → `unavailable`.
  - null-quantity item: ok, `items.quantity` stays null after purchase.
  - inactive (`isActive=false`) buyer → server action throws `unauthenticated_or_inactive` BEFORE entering `purchase()` (assert no order created).
  - item price changed between catalog render and purchase: caller passes stale price hint (if we adopt a hint param) OR test confirms the buyer is charged the CURRENT price and `pricePaid` snapshots the current price (not the stale catalog price).
  - snapshot fields stay frozen after subsequent item edits: update `items.name`, `items.description`, `items.redemptionInstructions`, `items.priceTacos`; existing order row's snapshots unchanged.
  - returns from `purchase()` carry the inserted order so caller can immediately post to Slack without a re-read.
- `tests/integration/purchase-concurrent.test.ts` (`withCleanDb`)
  - stock=1, two parallel purchases → one ok, one out_of_stock; `users.balance` debited exactly once for the buyer who succeeded; `items.quantity` ends at 0 (not -1).
  - stock=2, three parallel purchases → two ok, one out_of_stock; `items.quantity` ends at 0.
  - balance=N, price=N (two distinct buyers buying the same finite-stock item): standard happy path — one ok per buyer (stock permitting).
  - balance=N, price=N, single buyer, two parallel purchases → one ok, one insufficient; no double-debit.
- `tests/integration/fulfill.test.ts`
  - pending → fulfilled; `fulfilledAt`, `fulfilledByAdminId` populated.
  - balances + stock untouched by fulfill (assert pre/post values).
  - **no new transactions row** is inserted by fulfill (ledger invariant — fulfill is a state change, not a money move).
  - double-fulfill → second call `not_pending`; original `fulfilledByAdminId` preserved.
  - fulfilled → cancel rejected.
  - parallel fulfill from two admins → exactly one wins (`status='pending'` guard).
- `tests/integration/cancel.test.ts`
  - admin cancel: pending → cancelled; balance + stock restored to pre-purchase values; refund grant tx inserted with `orderId` + `adminUserId=admin` + `cancelledByAdminId=admin`; `order.refundTxId` patched.
  - buyer self-cancel: pending → cancelled; refund grant tx with `adminUserId IS NULL` + `cancelledByAdminId IS NULL` + `orderId` set; CHECK satisfied (proven via integration with constraint tests above).
  - defensive inner check: `cancelOrder` with `actor.kind='buyer'` and `actor.userId !== order.userId` → rejected without state change (matches outer auth).
  - null-quantity item: stock stays null after cancel.
  - cancel after item deactivated (`items.isActive=false` set between purchase and cancel): cancel still succeeds; stock still restored; FK reference intact.
  - cancelled → fulfill rejected.
  - double-cancel rejected.
  - race admin-cancel vs buyer-cancel: exactly one succeeds; second returns `not_pending`; refund posted exactly once.
  - race buyer-cancel vs admin-fulfill: exactly one transition wins; loser sees `not_pending`; no refund + fulfilled at once.
  - `balance ≤ receivedTotal` invariant survives for both actor kinds (assert constraint not violated via direct query).
  - ledger invariant: after a purchase + cancel cycle, the user's `receivedTotal` is unchanged, `balance` equals pre-purchase, and the ledger has exactly two new rows (redeem + grant) summing to net zero for that user.
- `tests/integration/cancel-my-order.test.ts` — server action `cancelMyOrder`:
  - buyer cancels own pending order → ok; identical end-state to admin cancel except for `adminUserId`/`cancelledByAdminId` nullness.
  - buyer attempts to cancel another buyer's order → error, state unchanged.
  - buyer attempts to cancel already-fulfilled order → error, state unchanged.
  - buyer attempts to cancel an already-cancelled order → error, state unchanged.
  - unauthenticated caller → error before any DB read.
  - feature flag `SHOP_SELF_SERVE_ENABLED=false` → action throws `disabled` regardless of session.
  - best-effort `chat.update` failure: throw mocked from Bolt client; DB end-state still cancelled; action does not re-raise.
- `tests/integration/order-actions-slack.test.ts` — mock Bolt client; simulate block_actions payload via the receiver:
  - admin clicks fulfill on pending → state fulfilled, `chat.update` called with fulfilled blocks, buyer DM sent.
  - admin clicks cancel on pending → state cancelled, `chat.update` called with admin-variant cancelled blocks, buyer DM sent (refund copy).
  - non-admin clicks fulfill → ephemeral "Not authorized" via `respond`, state unchanged, no `chat.update`.
  - non-admin clicks cancel → ephemeral "Not authorized", state unchanged.
  - admin clicks fulfill on already-cancelled order → ephemeral message describing current state, `chat.update` refresh with cancelled blocks (no state change).
  - admin clicks cancel on already-fulfilled order → ephemeral message, `chat.update` refresh with fulfilled blocks.
  - malformed `action.value` (not a uuid, or unknown id): handler returns gracefully with ephemeral error; no exception escapes Bolt.
  - `chat.update` API failure mocked: handler still acks within 3s and DB transition stands (assert via direct read).
- `tests/integration/receiver-interactivity.test.ts` — covers the open question about `AppRouterReceiver` parsing interactivity payloads.
  - POST with `Content-Type: application/x-www-form-urlencoded` body `payload=<JSON>` + valid Slack signature → receiver routes to Bolt; registered `app.action("order_fulfill", ...)` callback fires.
  - Same request with invalid signature → 401, no handler dispatched.
  - Replay attack (timestamp older than 5 min) → 401.
  - Receiver does NOT call `req.json()` before HMAC verify (regression guard — keep raw body).
- `tests/integration/admin-orders-actions.test.ts` — web server actions on `/admin/orders`:
  - admin session: fulfill action → state changes, `chat.update` invoked, buyer DM attempted.
  - admin session: cancel action → state cancelled, refund grant inserted with `adminUserId=admin`, `chat.update` invoked.
  - non-admin session calling admin action → throws `unauthorized`, no state change.
  - unauthenticated session → throws `unauthorized`.
  - `fulfillOrderAction` on already-fulfilled order → throws `already_fulfilled` (or maps to `not_pending`); UI error path covered.
  - `cancelOrderAction` on already-cancelled order → throws `already_cancelled`.
- `tests/integration/admin-orders-list.test.ts` — `listOrders` query helper:
  - filter by `status='pending'` returns only pending.
  - filter by `userId` returns only that buyer's orders.
  - filter by `itemId` returns only that item's orders.
  - cursor pagination returns stable ordering and no duplicates across pages.
  - default ordering: newest first by `createdAt`.
- `tests/integration/shop-page-auth.test.ts` — server-component rendering of `/shop`:
  - anonymous viewer: catalog renders, sign-in CTA present, no `Buy` buttons, no "Your pending orders" panel; `#tacoshop` fallback link rendered with correct `slack.com/app_redirect?channel=<TACOSHOP_CHANNEL_ID>` href.
  - signed-in non-admin viewer: catalog + Buy buttons + balance header; pending-orders panel hidden when empty; `#tacoshop` fallback link present.
  - signed-in viewer with a pending order: panel lists the order with Cancel button.
  - signed-in viewer with an out-of-stock item: corresponding Buy button is disabled.
  - signed-in viewer whose balance < item price: Buy button disabled (or marked "insufficient").
  - HR contact line is NOT present anywhere on `/shop` (regression guard for the replacement).
  - feature flag off: anonymous + signed-in viewers both see the legacy HR-contact catalog; no Buy buttons; no panel. (Pre-rollout snapshot; remove this case when the flag is retired.)
- `tests/integration/feature-flag.test.ts`
  - `SHOP_SELF_SERVE_ENABLED=false`: `buyItem` server action throws `disabled`; `cancelMyOrder` throws `disabled`; bot does NOT post to `#tacoshop` even if other paths somehow create an order (sanity).
  - `SHOP_SELF_SERVE_ENABLED=true`: end-to-end purchase posts to Slack channel (mocked).

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
  - Add `SHOP_SELF_SERVE_ENABLED`, `TACOSHOP_CHANNEL_ID` to env discussion. Note `HR_SLACK_ID` / `HR_SLACK_HANDLE` were only consumed by `/shop`; they become unused once the flag is on. Retire both env vars (config + `.env.example` + README + `lib/config.ts` `hr.*` getters) in the same follow-up PR that removes the feature flag.
  - Wrinkle: redeem rows are either admin-originated (adminUserId set, orderId null) OR shop-originated (adminUserId null, orderId set).
  - Wrinkle: refund grant rows (orderId set) carry `adminUserId IS NULL` for buyer self-cancel and `adminUserId = admin` for admin-cancel. The `orders.cancelledByAdminId` column mirrors this.
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
