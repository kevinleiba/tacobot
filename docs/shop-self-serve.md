# Self-serve shop

How users buy from the catalog, how admins fulfill, and how the bot keeps the `#tacoshop` channel in sync.

## High-level flow

```
buyer (web)              Next.js / Drizzle              Slack
─────────────            ─────────────────────         ──────────
sign in       ─signIn─►  insert user (active)
GET /shop                listActiveItems
click Buy     ─action─►  purchase(): tx {
                          FOR UPDATE item,
                          stock -= 1,
                          balance -= price,
                          insert order (pending),
                          insert redeem tx,
                          patch order.redeemTxId
                         }
                         post #tacoshop blocks ────►  posted message
                         patch order.slackMessageTs
                         DM buyer purchase summary ─►  buyer DM

admin (Slack click)      Bolt block_actions
"Mark fulfilled" ─►      fulfillOrder(): tx {
                          UPDATE orders
                          SET status='fulfilled'
                          WHERE id=? AND status='pending'
                         }
                         chat.update with fulfilled blocks ──► message updated
                         DM buyer "fulfilled" ────────────► buyer DM

admin or buyer cancel    cancelOrder({ actor }): tx {
                          SELECT … FOR UPDATE pending,
                          balance += price,
                          quantity += 1 if not null,
                          insert grant tx (orderId set;
                            adminUserId null when actor=buyer),
                          UPDATE orders cancelled
                         }
                         chat.update with cancelled blocks ──► message updated
                         DM buyer "cancelled" ────────────► buyer DM
```

## State machine

```
                    purchase()
                       │
                       ▼
                  ┌──────────┐
                  │ pending  │
                  └──────────┘
                   │        │
       fulfillOrder│        │cancelOrder
                   ▼        ▼
            ┌───────────┐ ┌────────────┐
            │ fulfilled │ │ cancelled  │
            └───────────┘ └────────────┘
                  (terminal)  (terminal — no further transitions)
```

`pending → fulfilled` and `pending → cancelled` are atomic and guarded by `WHERE status='pending'`. Re-clicking on a terminal-state order returns `not_pending` to the caller; the Slack handler replies with an ephemeral "already <state>" and refreshes the channel message via `chat.update` so all viewers see the current truth.

`fulfilled → cancelled` and `cancelled → fulfilled` are NOT possible. An admin who needs to "un-fulfill" must hand-correct via the audit log.

## Actor model

`cancelOrder()` takes an `actor: { kind: "admin" | "buyer"; userId: string }` discriminator that controls audit fields:

| `actor.kind` | `orders.cancelledByAdminId` | `transactions.adminUserId` on the grant refund row | Reason text |
|---|---|---|---|
| `admin` | admin Slack id | admin Slack id | `order cancelled by admin` |
| `buyer` | `NULL` | `NULL` | `order cancelled by buyer` |

The relaxed `transactions_shape_and_rule` CHECK accepts both grant shapes when `orderId` is set; admin-only grants (onboarding) still require `adminUserId NOT NULL` with `orderId NULL`.

## Failure modes

| Scenario | DB end-state | Slack side | UX |
|---|---|---|---|
| Buyer balance < price | Tx rolls back via `PurchaseAbort("insufficient")`. No order, no stock change. | Nothing posted. | Redirect to `/shop?err=insufficient`. |
| Stock=1 + two concurrent purchases | One commits, one rolls back via `PurchaseAbort("out_of_stock")`. Quantity ends at 0. | One message posted. | Loser redirected to `/shop?err=out_of_stock`. |
| Item deactivated between catalog render and click | `purchase()` returns `unavailable`. | Nothing posted. | `/shop?err=unavailable`. |
| Item price changed between render and click | Buyer charged CURRENT price (read inside the tx). The current price is then snapshotted into `orders.pricePaid`. | Posted with the new price. | UX accepts; no client-side hash check yet. |
| `chat.postMessage` to `#tacoshop` fails (e.g. bot not invited) | Order is in `pending` state with `slackMessageTs` NULL. | Nothing visible in channel. | Admin still sees the order on `/admin/orders` and can act there; web actions skip `chat.update` when `slackMessageTs` is NULL. |
| Two admins click `Mark fulfilled` simultaneously | First call commits; second returns `not_pending`. | First wins `chat.update`; second falls through to ephemeral + refresh `chat.update`. | Both admins see the fulfilled state. |
| Admin and buyer try to cancel at the same moment | One transaction commits via `FOR UPDATE` lock + `status='pending'` guard; other returns `not_pending`. Refund is inserted exactly once. | Whichever wins issues the `chat.update`. | Loser sees ephemeral "already <state>". |
| Buyer tries to cancel another user's order via crafted form | Outer auth in `cancelMyOrder` server action rejects (`order.userId !== sessionUserId`). Inner defence in `cancelOrder()` also rejects (`kind: "forbidden"`). | No Slack updates. | Redirect to `/shop?err=forbidden`. |
| Slack `chat.update` API fails after a DB transition | DB transition stands; ephemeral / DM still attempted. | Stale Slack message — next admin action will refresh it. | Acceptable; admin can manually re-trigger via web. |
| Unauthenticated POST to `/shop/actions` | Server actions throw `unauthenticated`. | Nothing. | Redirect to `/api/auth/signin?callbackUrl=/shop`. |
| `SHOP_SELF_SERVE_ENABLED=false` | `buyItem` / `cancelMyOrder` early-return via `redirect("/shop?err=disabled")`. `/shop` hides Buy buttons + pending-orders panel. | Nothing. | Legacy catalog view. |

## Ledger invariants preserved

- `balance ≤ receivedTotal` holds across purchase + cancel cycles because purchase decrements `balance` only, and cancel restores `balance` by the same amount; `receivedTotal` is untouched throughout.
- Net-zero per buyer after purchase + cancel: ledger sum = `-pricePaid` (redeem) + `+pricePaid` (grant) = `0`.
- Append-only: cancel does NOT delete the redeem row — it inserts a compensating grant row linked via `orderId`. Same pattern as give-reversal.

## Audit queries

Recent self-serve orders:

```sql
SELECT
  o.created_at, o.status, o.user_id, o.item_name_snap, o.price_paid,
  o.fulfilled_by_admin_id, o.cancelled_by_admin_id
FROM orders o
ORDER BY o.created_at DESC
LIMIT 20;
```

Orders pending older than 7 days:

```sql
SELECT id, user_id, item_name_snap, price_paid, created_at
FROM orders
WHERE status='pending'
  AND created_at < now() - interval '7 days'
ORDER BY created_at;
```

Ledger trace for a single order:

```sql
SELECT t.type, t.amount, t.admin_user_id, t.reason, t.created_at
FROM transactions t
WHERE t.order_id = '<order id>'
ORDER BY t.created_at;
```

Top buyers by spend (self-serve only):

```sql
SELECT user_id, COUNT(*) orders_count, SUM(price_paid) total_spend
FROM orders
WHERE status='fulfilled'
GROUP BY user_id
ORDER BY total_spend DESC;
```
