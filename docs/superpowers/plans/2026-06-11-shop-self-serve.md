# Shop self-serve with pending orders — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in Slack users redeem shop items themselves: atomic balance debit + stock decrement + pending order, with Slack `#tacoshop` channel message + admin fulfill/cancel + buyer self-cancel.

**Architecture:** New `orders` table, new `lib/shop/{purchase,fulfill,cancel}.ts` domain functions, Bolt `app.action` handlers for `#tacoshop` buttons, new `/admin/orders` page, rebuilt `/shop` with auth + Buy buttons + pending-orders panel + `#tacoshop` alt link. Auth gate relaxed to admit any active user; admin allowlist enforced in admin layout. Behind `SHOP_SELF_SERVE_ENABLED` flag.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM, Slack Bolt v4, Auth.js v5, Tailwind, PGlite for tests.

**Reference:** Spec `docs/superpowers/specs/2026-05-29-shop-self-serve-design.md`.

---

## File map

**New:**
- `lib/shop/purchase.ts`, `lib/shop/fulfill.ts`, `lib/shop/cancel.ts` — domain.
- `lib/shop/types.ts` — shared `Actor` / result kinds.
- `lib/slack/handlers/orderActions.ts` — Bolt `block_actions` handlers.
- `app/admin/orders/page.tsx`, `app/admin/orders/actions.ts` — admin orders UI.
- `app/shop/actions.ts` — `buyItem`, `cancelMyOrder` server actions.
- `app/shop/PendingOrders.tsx` — client component (confirm dialog).
- Tests: `tests/integration/{purchase,purchase-concurrent,fulfill,cancel,cancel-my-order,order-actions-slack,receiver-interactivity,admin-orders-actions,admin-orders-list,shop-page-auth,feature-flag,schema-constraints-orders,schema-constraints-transactions}.test.ts` + `tests/unit/{format-orders,auth-signin}.test.ts`.

**Modified:**
- `lib/db/schema.ts` — add `orders` table + `orderId` on `transactions` + relax `shape_and_rule` CHECK.
- `lib/db/queries.ts` — add `listOrders`, `getOrderById`, `ensureUserExists` (verify exists).
- `lib/config.ts` — add `tacoshopChannelId` (required), `shopSelfServeEnabled` (default false).
- `lib/slack/format.ts` — `orderPostedBlocks`, `orderFulfilledBlocks`, `orderCancelledBlocks`, DM strings.
- `lib/slack/handlers.ts` — wire `registerOrderActionHandlers()`.
- `lib/slack/receiver.ts` — decode `application/x-www-form-urlencoded` payload.
- `lib/auth.ts` — relax `signIn` callback; auto-insert user.
- `app/admin/layout.tsx` — admin allowlist gate.
- `app/shop/page.tsx` — sign-in CTA, Buy buttons, pending-orders panel, `#tacoshop` link.
- `.env.example`, `README.md`, `CLAUDE.md`, `docs/slack-setup.md`.
- New `drizzle/0004_*.sql` migration.

---

## Phase 1 — Schema + migrations

### Task 1.1: Extend schema

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Add `orders` table + `orderId` FK + relax `shape_and_rule` CHECK**

Append after the `transactions` definition:

```ts
export const orderStatus = ["pending", "fulfilled", "cancelled"] as const;
export type OrderStatus = (typeof orderStatus)[number];

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id),
    itemId: uuid("item_id").notNull().references(() => items.id),
    itemNameSnap: text("item_name_snap").notNull(),
    descriptionSnap: text("description_snap"),
    redemptionInstructionsSnap: text("redemption_instructions_snap"),
    pricePaid: integer("price_paid").notNull(),
    status: text("status", { enum: orderStatus }).notNull().default("pending"),
    redeemTxId: uuid("redeem_tx_id"),
    refundTxId: uuid("refund_tx_id"),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    fulfilledByAdminId: text("fulfilled_by_admin_id").references(() => users.id),
    cancelledByAdminId: text("cancelled_by_admin_id").references(() => users.id),
  },
  (t) => ({
    pricePositive: check("orders_price_positive", sql`${t.pricePaid} > 0`),
    stateConsistency: check(
      "orders_state_consistency",
      sql`(
        (${t.status} = 'pending'
          AND ${t.fulfilledAt} IS NULL AND ${t.cancelledAt} IS NULL
          AND ${t.fulfilledByAdminId} IS NULL AND ${t.cancelledByAdminId} IS NULL
          AND ${t.refundTxId} IS NULL)
        OR
        (${t.status} = 'fulfilled'
          AND ${t.fulfilledAt} IS NOT NULL AND ${t.fulfilledByAdminId} IS NOT NULL
          AND ${t.cancelledAt} IS NULL AND ${t.cancelledByAdminId} IS NULL
          AND ${t.refundTxId} IS NULL)
        OR
        (${t.status} = 'cancelled'
          AND ${t.cancelledAt} IS NOT NULL AND ${t.refundTxId} IS NOT NULL
          AND ${t.fulfilledAt} IS NULL AND ${t.fulfilledByAdminId} IS NULL)
      )`,
    ),
    statusCreatedIdx: index("orders_status_created").on(t.status, t.createdAt),
    userCreatedIdx: index("orders_user_created").on(t.userId, t.createdAt),
    itemCreatedIdx: index("orders_item_created").on(t.itemId, t.createdAt),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
```

Add `orderId` to `transactions` columns:
```ts
orderId: uuid("order_id"),
```

(Skip FK constraint at column level to avoid the circular FK headache; we'll enforce relationship in code. A self-referential or cross-table FK would also cause migration ordering issues.)

Replace the `shape_and_rule` CHECK in `transactions` with:
```ts
shapeAndRule: check(
  "transactions_shape_and_rule",
  sql`(
    (${t.type} = 'give'
      AND ${t.fromUserId} IS NOT NULL
      AND ${t.adminUserId} IS NULL
      AND ${t.itemId} IS NULL
      AND ${t.reversedTransactionId} IS NULL
      AND ${t.orderId} IS NULL
      AND ${t.fromUserId} <> ${t.toUserId})
    OR
    (${t.type} = 'redeem'
      AND ${t.fromUserId} IS NULL
      AND ${t.itemId} IS NOT NULL
      AND ${t.reversedTransactionId} IS NULL
      AND (
        (${t.adminUserId} IS NOT NULL AND ${t.orderId} IS NULL)
        OR (${t.adminUserId} IS NULL AND ${t.orderId} IS NOT NULL)
      ))
    OR
    (${t.type} = 'reversal'
      AND ${t.fromUserId} IS NULL
      AND ${t.adminUserId} IS NULL
      AND ${t.itemId} IS NULL
      AND ${t.reversedTransactionId} IS NOT NULL
      AND ${t.orderId} IS NULL)
    OR
    (${t.type} = 'grant'
      AND ${t.fromUserId} IS NULL
      AND ${t.itemId} IS NULL
      AND ${t.reversedTransactionId} IS NULL
      AND (
        (${t.adminUserId} IS NOT NULL AND ${t.orderId} IS NULL)
        OR (${t.orderId} IS NOT NULL)
      ))
  )`,
),
```

- [ ] **Step 2: Generate migration**

Run: `pnpm db:generate`
Expected: new file `drizzle/0004_*.sql` created.

- [ ] **Step 3: Verify migration loads in PGlite**

Run: `pnpm vitest run tests/integration/db-smoke.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts drizzle/0004_*.sql drizzle/meta
git commit -m "feat(db): add orders table and orderId on transactions"
```

---

## Phase 2 — Schema constraint tests

### Task 2.1: Orders CHECK suite

**Files:**
- Create: `tests/integration/schema-constraints-orders.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, users } from "@/lib/db/schema";

async function seed(tx: Awaited<ReturnType<typeof getDb>>) {
  await tx.insert(users).values({ id: "UBUYER", name: "Buyer", dailyRemaining: 5 });
  const [item] = await tx
    .insert(items)
    .values({ name: "Mug", priceTacos: 10 })
    .returning();
  return { itemId: item.id };
}

describe("orders CHECK", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("rejects pending with fulfilledAt set", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(
        tx.insert(orders).values({
          userId: "UBUYER",
          itemId,
          itemNameSnap: "Mug",
          pricePaid: 10,
          status: "pending",
          fulfilledAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  it("rejects fulfilled without fulfilledByAdminId", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(
        tx.insert(orders).values({
          userId: "UBUYER",
          itemId,
          itemNameSnap: "Mug",
          pricePaid: 10,
          status: "fulfilled",
          fulfilledAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  it("rejects cancelled without refundTxId", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(
        tx.insert(orders).values({
          userId: "UBUYER",
          itemId,
          itemNameSnap: "Mug",
          pricePaid: 10,
          status: "cancelled",
          cancelledAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  it("accepts cancelled with no admin (self-cancel) when refundTxId set", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      const fakeRefundId = crypto.randomUUID();
      await tx.insert(orders).values({
        userId: "UBUYER",
        itemId,
        itemNameSnap: "Mug",
        pricePaid: 10,
        status: "cancelled",
        cancelledAt: new Date(),
        refundTxId: fakeRefundId,
      });
      const found = await tx.execute(sql`SELECT count(*)::int as n FROM orders`);
      expect((found as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);
    });
  });

  it("rejects non-positive price", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(
        tx.insert(orders).values({
          userId: "UBUYER",
          itemId,
          itemNameSnap: "Mug",
          pricePaid: 0,
        }),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run tests/integration/schema-constraints-orders.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/schema-constraints-orders.test.ts
git commit -m "test(orders): cover schema CHECK constraints"
```

### Task 2.2: Transactions CHECK suite

**Files:**
- Create: `tests/integration/schema-constraints-transactions.test.ts`

- [ ] **Step 1: Write test (covers redeem + grant relaxations)**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, transactions, users } from "@/lib/db/schema";

async function seed(tx: Awaited<ReturnType<typeof getDb>>) {
  await tx.insert(users).values([
    { id: "UADMIN", name: "Admin", dailyRemaining: 5 },
    { id: "UBUYER", name: "Buyer", dailyRemaining: 5 },
  ]);
  const [item] = await tx
    .insert(items)
    .values({ name: "Mug", priceTacos: 10 })
    .returning();
  return { itemId: item.id, orderId: crypto.randomUUID() };
}

describe("transactions shape_and_rule CHECK", () => {
  beforeAll(async () => { await getDb(); });

  it("rejects redeem with neither admin nor order", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(tx.insert(transactions).values({
        type: "redeem", toUserId: "UBUYER", itemId, amount: 10,
      })).rejects.toThrow();
    });
  });

  it("accepts redeem with admin only (admin manual deduct)", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "redeem", toUserId: "UBUYER", adminUserId: "UADMIN",
        itemId, amount: 10,
      });
    });
  });

  it("accepts redeem with order only (self-serve)", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId, orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "redeem", toUserId: "UBUYER", itemId, amount: 10, orderId,
      });
    });
  });

  it("rejects redeem with both admin and order", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId, orderId } = await seed(tx);
      await expect(tx.insert(transactions).values({
        type: "redeem", toUserId: "UBUYER", adminUserId: "UADMIN",
        itemId, amount: 10, orderId,
      })).rejects.toThrow();
    });
  });

  it("accepts grant admin-only (onboarding)", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      await tx.insert(transactions).values({
        type: "grant", toUserId: "UBUYER", adminUserId: "UADMIN", amount: 5,
      });
    });
  });

  it("accepts grant with order only (self-cancel refund)", async () => {
    await inRollbackTx(async (tx) => {
      const { orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "grant", toUserId: "UBUYER", amount: 10, orderId,
      });
    });
  });

  it("accepts grant with admin + order (admin cancel refund)", async () => {
    await inRollbackTx(async (tx) => {
      const { orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "grant", toUserId: "UBUYER", adminUserId: "UADMIN",
        amount: 10, orderId,
      });
    });
  });

  it("rejects grant with neither admin nor order", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      await expect(tx.insert(transactions).values({
        type: "grant", toUserId: "UBUYER", amount: 5,
      })).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm vitest run tests/integration/schema-constraints-transactions.test.ts
git add tests/integration/schema-constraints-transactions.test.ts
git commit -m "test(tx): cover relaxed shape_and_rule for redeem/grant"
```

---

## Phase 3 — Config + feature flag

### Task 3.1: Add new env getters

**Files:**
- Modify: `lib/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add to `config` object**

After `cronSecret`:
```ts
get tacoshopChannelId(): string {
  return required({
    name: "TACOSHOP_CHANNEL_ID",
    usedFor: "channel where self-serve shop orders are announced",
  });
},
get shopSelfServeEnabled(): boolean {
  return boolWithDefault("SHOP_SELF_SERVE_ENABLED", false);
},
```

- [ ] **Step 2: Update `.env.example`**

Add rows:
```
SHOP_SELF_SERVE_ENABLED=false              # flag for self-serve /shop flow
TACOSHOP_CHANNEL_ID=C0123ABCDE             # required when flag is on
```

- [ ] **Step 3: Commit**

```bash
git add lib/config.ts .env.example
git commit -m "feat(config): add tacoshop channel + self-serve flag"
```

---

## Phase 4 — Domain functions

### Task 4.1: `purchase()` core

**Files:**
- Create: `lib/shop/types.ts`
- Create: `lib/shop/purchase.ts`

- [ ] **Step 1: Types**

```ts
// lib/shop/types.ts
export type Actor = { kind: "admin" | "buyer"; userId: string };
export type Order = import("@/lib/db/schema").Order;
```

- [ ] **Step 2: `purchase.ts`**

```ts
// lib/shop/purchase.ts
import { and, eq, gte, sql } from "drizzle-orm";
import { items, orders, transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { Order } from "@/lib/db/schema";

export type PurchaseInput = { userId: string; itemId: string };
export type PurchaseResult =
  | { kind: "ok"; order: Order }
  | { kind: "unavailable" }
  | { kind: "out_of_stock" }
  | { kind: "insufficient" };

export async function purchase(
  db: DbLike,
  input: PurchaseInput,
): Promise<PurchaseResult> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: items.id,
        name: items.name,
        description: items.description,
        redemptionInstructions: items.redemptionInstructions,
        priceTacos: items.priceTacos,
        quantity: items.quantity,
      })
      .from(items)
      .where(and(eq(items.id, input.itemId), eq(items.isActive, true)))
      .for("update");
    if (!item) return { kind: "unavailable" } as const;

    if (item.quantity !== null) {
      const dec = await tx
        .update(items)
        .set({ quantity: sql`${items.quantity} - 1`, updatedAt: sql`now()` })
        .where(and(eq(items.id, item.id), gte(items.quantity, 1)))
        .returning({ id: items.id });
      if (dec.length === 0) return { kind: "out_of_stock" } as const;
    }

    const debited = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${item.priceTacos}`, updatedAt: sql`now()` })
      .where(and(eq(users.id, input.userId), gte(users.balance, item.priceTacos)))
      .returning({ id: users.id });
    if (debited.length === 0) return { kind: "insufficient" } as const;

    const [order] = await tx
      .insert(orders)
      .values({
        userId: input.userId,
        itemId: item.id,
        itemNameSnap: item.name,
        descriptionSnap: item.description,
        redemptionInstructionsSnap: item.redemptionInstructions,
        pricePaid: item.priceTacos,
        status: "pending",
      })
      .returning();

    const [redeemTx] = await tx
      .insert(transactions)
      .values({
        type: "redeem",
        toUserId: input.userId,
        itemId: item.id,
        amount: item.priceTacos,
        orderId: order.id,
        reason: "self-serve shop purchase",
      })
      .returning();

    const [patched] = await tx
      .update(orders)
      .set({ redeemTxId: redeemTx.id })
      .where(eq(orders.id, order.id))
      .returning();

    return { kind: "ok", order: patched } as const;
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/shop/types.ts lib/shop/purchase.ts
git commit -m "feat(shop): atomic purchase() with stock + balance + order + ledger"
```

### Task 4.2: `purchase()` tests

**Files:**
- Create: `tests/integration/purchase.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, transactions, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";

describe("purchase()", () => {
  beforeAll(async () => { await getDb(); });

  async function seed(tx: Awaited<ReturnType<typeof getDb>>, opts?: {
    balance?: number; quantity?: number | null; price?: number;
  }) {
    const balance = opts?.balance ?? 50;
    const quantity = opts?.quantity === undefined ? 3 : opts.quantity;
    const price = opts?.price ?? 10;
    await tx.insert(users).values({
      id: "UBUYER", name: "Buyer", dailyRemaining: 5,
      balance, receivedTotal: balance,
    });
    const [item] = await tx.insert(items).values({
      name: "Mug", description: "ceramic", redemptionInstructions: "ask Pat",
      priceTacos: price, quantity,
    }).returning();
    return { itemId: item.id, price, quantity };
  }

  it("happy path: debits balance, decrements stock, inserts order + redeem tx", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId, price } = await seed(tx);
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("ok");

      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBe(50 - price);
      const [it] = await tx.select().from(items).where(eq(items.id, itemId));
      expect(it.quantity).toBe(2);
      const [o] = await tx.select().from(orders).where(eq(orders.userId, "UBUYER"));
      expect(o.status).toBe("pending");
      expect(o.pricePaid).toBe(price);
      expect(o.itemNameSnap).toBe("Mug");
      expect(o.descriptionSnap).toBe("ceramic");
      expect(o.redemptionInstructionsSnap).toBe("ask Pat");
      expect(o.redeemTxId).not.toBeNull();
      const [t] = await tx.select().from(transactions).where(eq(transactions.orderId, o.id));
      expect(t.type).toBe("redeem");
      expect(t.adminUserId).toBeNull();
    });
  });

  it("insufficient balance: no row changes", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx, { balance: 5, price: 10 });
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("insufficient");
      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBe(5);
      const [it] = await tx.select().from(items).where(eq(items.id, itemId));
      expect(it.quantity).toBe(3);
      const oCount = await tx.select().from(orders);
      expect(oCount.length).toBe(0);
    });
  });

  it("boundary: balance === price → ok", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx, { balance: 10, price: 10 });
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("ok");
      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBe(0);
    });
  });

  it("balance === 0 → insufficient", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx, { balance: 0, price: 1 });
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("insufficient");
    });
  });

  it("out of stock (sequential): first ok, second out_of_stock", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx, { quantity: 1, balance: 100 });
      const r1 = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r1.kind).toBe("ok");
      const r2 = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r2.kind).toBe("out_of_stock");
    });
  });

  it("inactive item → unavailable", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await tx.update(items).set({ isActive: false }).where(eq(items.id, itemId));
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("unavailable");
    });
  });

  it("null-quantity item: ok, quantity stays null", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx, { quantity: null });
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      expect(r.kind).toBe("ok");
      const [it] = await tx.select().from(items).where(eq(items.id, itemId));
      expect(it.quantity).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm vitest run tests/integration/purchase.test.ts
git add tests/integration/purchase.test.ts
git commit -m "test(shop): cover purchase() happy path + error cases"
```

### Task 4.3: `fulfill()`

**Files:**
- Create: `lib/shop/fulfill.ts`
- Create: `tests/integration/fulfill.test.ts`

- [ ] **Step 1: Implementation**

```ts
// lib/shop/fulfill.ts
import { and, eq, sql } from "drizzle-orm";
import { orders } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { Order } from "@/lib/db/schema";

export type FulfillInput = { orderId: string; adminId: string };
export type FulfillResult = { kind: "ok"; order: Order } | { kind: "not_pending" };

export async function fulfillOrder(
  db: DbLike,
  input: FulfillInput,
): Promise<FulfillResult> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({
        status: "fulfilled",
        fulfilledAt: sql`now()`,
        fulfilledByAdminId: input.adminId,
      })
      .where(and(eq(orders.id, input.orderId), eq(orders.status, "pending")))
      .returning();
    if (updated.length === 0) return { kind: "not_pending" } as const;
    return { kind: "ok", order: updated[0] } as const;
  });
}
```

- [ ] **Step 2: Tests**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, users, transactions } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";
import { fulfillOrder } from "@/lib/shop/fulfill";

describe("fulfillOrder()", () => {
  beforeAll(async () => { await getDb(); });

  async function setup(tx: Awaited<ReturnType<typeof getDb>>) {
    await tx.insert(users).values([
      { id: "UBUYER", name: "Buyer", dailyRemaining: 5, balance: 50, receivedTotal: 50 },
      { id: "UADMIN", name: "Admin", dailyRemaining: 5, balance: 0, receivedTotal: 0 },
    ]);
    const [item] = await tx.insert(items).values({ name: "Mug", priceTacos: 10, quantity: 3 }).returning();
    const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
    if (r.kind !== "ok") throw new Error("seed purchase failed");
    return { order: r.order, item };
  }

  it("pending → fulfilled", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const r = await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      expect(r.kind).toBe("ok");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("fulfilled");
      expect(o.fulfilledByAdminId).toBe("UADMIN");
      expect(o.fulfilledAt).not.toBeNull();
    });
  });

  it("balance + stock untouched by fulfill", async () => {
    await inRollbackTx(async (tx) => {
      const { order, item } = await setup(tx);
      const beforeUser = (await tx.select().from(users).where(eq(users.id, "UBUYER")))[0];
      const beforeItem = (await tx.select().from(items).where(eq(items.id, item.id)))[0];
      await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      const afterUser = (await tx.select().from(users).where(eq(users.id, "UBUYER")))[0];
      const afterItem = (await tx.select().from(items).where(eq(items.id, item.id)))[0];
      expect(afterUser.balance).toBe(beforeUser.balance);
      expect(afterItem.quantity).toBe(beforeItem.quantity);
    });
  });

  it("fulfill does not insert a ledger row", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const before = await tx.select().from(transactions);
      await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      const after = await tx.select().from(transactions);
      expect(after.length).toBe(before.length);
    });
  });

  it("double-fulfill returns not_pending", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      const r = await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      expect(r.kind).toBe("not_pending");
    });
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm vitest run tests/integration/fulfill.test.ts
git add lib/shop/fulfill.ts tests/integration/fulfill.test.ts
git commit -m "feat(shop): fulfillOrder() + tests"
```

### Task 4.4: `cancel()`

**Files:**
- Create: `lib/shop/cancel.ts`
- Create: `tests/integration/cancel.test.ts`

- [ ] **Step 1: Implementation**

```ts
// lib/shop/cancel.ts
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { items, orders, transactions } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { Order } from "@/lib/db/schema";
import type { Actor } from "./types";

export type CancelInput = { orderId: string; actor: Actor };
export type CancelResult =
  | { kind: "ok"; order: Order; refundTxId: string }
  | { kind: "not_pending" }
  | { kind: "forbidden" };

export async function cancelOrder(
  db: DbLike,
  input: CancelInput,
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.status, "pending")))
      .for("update");
    if (!order) return { kind: "not_pending" } as const;

    if (input.actor.kind === "buyer" && order.userId !== input.actor.userId) {
      return { kind: "forbidden" } as const;
    }

    await tx
      .update(orders.userId === "" ? orders : orders) // noop
      .set({})
      .where(eq(orders.id, order.id));

    // Refund balance only — receivedTotal not touched (purchase didn't touch it).
    await tx
      .update(/* users */ (await import("@/lib/db/schema")).users)
      .set({
        balance: sql`balance + ${order.pricePaid}`,
        updatedAt: sql`now()`,
      })
      .where(eq((await import("@/lib/db/schema")).users.id, order.userId));

    // Restore stock when item tracks quantity.
    await tx
      .update(items)
      .set({ quantity: sql`${items.quantity} + 1`, updatedAt: sql`now()` })
      .where(and(eq(items.id, order.itemId), isNotNull(items.quantity)));

    const isAdmin = input.actor.kind === "admin";
    const [refundTx] = await tx
      .insert(transactions)
      .values({
        type: "grant",
        toUserId: order.userId,
        adminUserId: isAdmin ? input.actor.userId : null,
        amount: order.pricePaid,
        orderId: order.id,
        reason: isAdmin ? "order cancelled by admin" : "order cancelled by buyer",
      })
      .returning();

    const [patched] = await tx
      .update(orders)
      .set({
        status: "cancelled",
        cancelledAt: sql`now()`,
        cancelledByAdminId: isAdmin ? input.actor.userId : null,
        refundTxId: refundTx.id,
      })
      .where(eq(orders.id, order.id))
      .returning();

    return { kind: "ok", order: patched, refundTxId: refundTx.id } as const;
  });
}
```

(Clean up the noop `tx.update` and dynamic import in the next step — drafted above as placeholder. Re-write cleanly:)

```ts
// lib/shop/cancel.ts
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { items, orders, transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { Order } from "@/lib/db/schema";
import type { Actor } from "./types";

export type CancelInput = { orderId: string; actor: Actor };
export type CancelResult =
  | { kind: "ok"; order: Order; refundTxId: string }
  | { kind: "not_pending" }
  | { kind: "forbidden" };

export async function cancelOrder(
  db: DbLike,
  input: CancelInput,
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.status, "pending")))
      .for("update");
    if (!order) return { kind: "not_pending" } as const;

    if (input.actor.kind === "buyer" && order.userId !== input.actor.userId) {
      return { kind: "forbidden" } as const;
    }

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${order.pricePaid}`, updatedAt: sql`now()` })
      .where(eq(users.id, order.userId));

    await tx
      .update(items)
      .set({ quantity: sql`${items.quantity} + 1`, updatedAt: sql`now()` })
      .where(and(eq(items.id, order.itemId), isNotNull(items.quantity)));

    const isAdmin = input.actor.kind === "admin";
    const [refundTx] = await tx
      .insert(transactions)
      .values({
        type: "grant",
        toUserId: order.userId,
        adminUserId: isAdmin ? input.actor.userId : null,
        amount: order.pricePaid,
        orderId: order.id,
        reason: isAdmin ? "order cancelled by admin" : "order cancelled by buyer",
      })
      .returning();

    const [patched] = await tx
      .update(orders)
      .set({
        status: "cancelled",
        cancelledAt: sql`now()`,
        cancelledByAdminId: isAdmin ? input.actor.userId : null,
        refundTxId: refundTx.id,
      })
      .where(eq(orders.id, order.id))
      .returning();

    return { kind: "ok", order: patched, refundTxId: refundTx.id } as const;
  });
}
```

- [ ] **Step 2: Tests**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, transactions, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";
import { cancelOrder } from "@/lib/shop/cancel";
import { fulfillOrder } from "@/lib/shop/fulfill";

describe("cancelOrder()", () => {
  beforeAll(async () => { await getDb(); });

  async function setup(tx: Awaited<ReturnType<typeof getDb>>) {
    await tx.insert(users).values([
      { id: "UBUYER", name: "Buyer", dailyRemaining: 5, balance: 50, receivedTotal: 50 },
      { id: "UADMIN", name: "Admin", dailyRemaining: 5 },
      { id: "UOTHER", name: "Other", dailyRemaining: 5 },
    ]);
    const [item] = await tx.insert(items).values({ name: "Mug", priceTacos: 10, quantity: 3 }).returning();
    const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
    if (r.kind !== "ok") throw new Error("seed failed");
    return { order: r.order, item };
  }

  it("admin cancel: restores balance + stock + inserts admin grant", async () => {
    await inRollbackTx(async (tx) => {
      const { order, item } = await setup(tx);
      const r = await cancelOrder(tx, { orderId: order.id, actor: { kind: "admin", userId: "UADMIN" } });
      expect(r.kind).toBe("ok");
      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBe(50);
      const [it] = await tx.select().from(items).where(eq(items.id, item.id));
      expect(it.quantity).toBe(3);
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("cancelled");
      expect(o.cancelledByAdminId).toBe("UADMIN");
      expect(o.refundTxId).not.toBeNull();
      const [t] = await tx.select().from(transactions).where(eq(transactions.id, o.refundTxId!));
      expect(t.type).toBe("grant");
      expect(t.adminUserId).toBe("UADMIN");
      expect(t.amount).toBe(10);
    });
  });

  it("buyer self-cancel: admin fields null on order + grant", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const r = await cancelOrder(tx, { orderId: order.id, actor: { kind: "buyer", userId: "UBUYER" } });
      expect(r.kind).toBe("ok");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.cancelledByAdminId).toBeNull();
      const [t] = await tx.select().from(transactions).where(eq(transactions.id, o.refundTxId!));
      expect(t.adminUserId).toBeNull();
    });
  });

  it("forbidden: another buyer cannot self-cancel", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const r = await cancelOrder(tx, { orderId: order.id, actor: { kind: "buyer", userId: "UOTHER" } });
      expect(r.kind).toBe("forbidden");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("pending");
    });
  });

  it("cancelled → fulfill rejected", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, { orderId: order.id, actor: { kind: "admin", userId: "UADMIN" } });
      const r = await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      expect(r.kind).toBe("not_pending");
    });
  });

  it("double-cancel rejected", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, { orderId: order.id, actor: { kind: "admin", userId: "UADMIN" } });
      const r = await cancelOrder(tx, { orderId: order.id, actor: { kind: "admin", userId: "UADMIN" } });
      expect(r.kind).toBe("not_pending");
    });
  });

  it("null-quantity item: stock stays null", async () => {
    await inRollbackTx(async (tx) => {
      await tx.insert(users).values({ id: "UBUYER", name: "Buyer", dailyRemaining: 5, balance: 50, receivedTotal: 50 });
      const [item] = await tx.insert(items).values({ name: "Mug", priceTacos: 10, quantity: null }).returning();
      const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
      if (r.kind !== "ok") throw new Error();
      await tx.insert(users).values({ id: "UADMIN", name: "Admin", dailyRemaining: 5 });
      await cancelOrder(tx, { orderId: r.order.id, actor: { kind: "admin", userId: "UADMIN" } });
      const [it] = await tx.select().from(items).where(eq(items.id, item.id));
      expect(it.quantity).toBeNull();
    });
  });

  it("ledger net-zero after purchase + cancel", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, { orderId: order.id, actor: { kind: "admin", userId: "UADMIN" } });
      const txs = await tx.select().from(transactions).where(eq(transactions.toUserId, "UBUYER"));
      const sum = txs.reduce((acc, r) => acc + (r.type === "redeem" ? -r.amount : r.amount), 0);
      expect(sum).toBe(0);
    });
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm vitest run tests/integration/cancel.test.ts
git add lib/shop/cancel.ts tests/integration/cancel.test.ts
git commit -m "feat(shop): cancelOrder() + tests"
```

---

## Phase 5 — Slack format helpers + handler

### Task 5.1: Block kit + DM strings

**Files:**
- Modify: `lib/slack/format.ts`
- Create: `tests/unit/format-orders.test.ts`

- [ ] **Step 1: Append to `format.ts`**

```ts
import type { KnownBlock } from "@slack/types";

export type OrderBlocksInput = {
  orderId: string;
  buyerUserId: string;
  itemName: string;
  price: number;
  imageUrl?: string | null;
  redemptionInstructions?: string | null;
  emojiName: string;
};

const emoji = (name: string) => `:${name}:`;
const shortId = (id: string) => id.slice(0, 8);

export function orderPostedBlocks(
  input: OrderBlocksInput,
): { blocks: KnownBlock[]; text: string } {
  const text = `<@${input.buyerUserId}> ordered ${input.itemName} for ${input.price} ${emoji(input.emojiName)}`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<@${input.buyerUserId}> ordered *${input.itemName}* for *${input.price} ${emoji(input.emojiName)}*` },
      accessory: input.imageUrl
        ? { type: "image", image_url: input.imageUrl, alt_text: input.itemName }
        : undefined,
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Order \`${shortId(input.orderId)}\` · pending${input.redemptionInstructions ? ` · ${input.redemptionInstructions}` : ""}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "order_fulfill",
          value: input.orderId,
          text: { type: "plain_text", text: "Mark fulfilled" },
          style: "primary",
        },
        {
          type: "button",
          action_id: "order_cancel",
          value: input.orderId,
          text: { type: "plain_text", text: "Cancel & refund" },
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Cancel order?" },
            text: { type: "mrkdwn", text: `Refund *${input.price} ${emoji(input.emojiName)}* to <@${input.buyerUserId}>?` },
            confirm: { type: "plain_text", text: "Cancel order" },
            deny: { type: "plain_text", text: "Keep" },
          },
        },
      ],
    },
  ];
  return { blocks, text };
}

export function orderFulfilledBlocks(
  input: OrderBlocksInput & { fulfilledByAdminId: string },
): { blocks: KnownBlock[]; text: string } {
  const text = `Order ${input.itemName} fulfilled`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<@${input.buyerUserId}> ordered *${input.itemName}* for *${input.price} ${emoji(input.emojiName)}*` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Order \`${shortId(input.orderId)}\` · ✅ fulfilled by <@${input.fulfilledByAdminId}>` },
      ],
    },
  ];
  return { blocks, text };
}

export function orderCancelledBlocks(
  input: OrderBlocksInput & { cancelledByAdminId: string | null },
): { blocks: KnownBlock[]; text: string } {
  const by = input.cancelledByAdminId
    ? `<@${input.cancelledByAdminId}>`
    : "buyer";
  const text = `Order ${input.itemName} cancelled`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<@${input.buyerUserId}> ordered *${input.itemName}* for *${input.price} ${emoji(input.emojiName)}*` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Order \`${shortId(input.orderId)}\` · ❌ cancelled by ${by} · ${input.price} ${emoji(input.emojiName)} refunded` },
      ],
    },
  ];
  return { blocks, text };
}

export function purchaseConfirmationDm(itemName: string, price: number, balanceAfter: number, emojiName: string): string {
  return `You bought *${itemName}* for *${price} ${emoji(emojiName)}*. Balance: ${balanceAfter} ${emoji(emojiName)}.`;
}

export function orderFulfilledDm(itemName: string, adminId: string, emojiName: string): string {
  return `Your *${itemName}* order was fulfilled by <@${adminId}>. ${emoji(emojiName)}`;
}

export function orderCancelledDm(itemName: string, price: number, cancelledByAdminId: string | null, emojiName: string): string {
  const by = cancelledByAdminId ? `<@${cancelledByAdminId}>` : "you";
  return `Your *${itemName}* order was cancelled by ${by}. *${price} ${emoji(emojiName)}* refunded.`;
}
```

- [ ] **Step 2: Unit tests**

```ts
import { describe, it, expect } from "vitest";
import {
  orderPostedBlocks, orderFulfilledBlocks, orderCancelledBlocks,
  purchaseConfirmationDm, orderFulfilledDm, orderCancelledDm,
} from "@/lib/slack/format";

const base = {
  orderId: "11111111-2222-3333-4444-555555555555",
  buyerUserId: "UBUYER",
  itemName: "Mug",
  price: 10,
  emojiName: "taco",
};

describe("orderPostedBlocks", () => {
  it("includes buyer mention, price, both buttons with action_ids and confirm dialog", () => {
    const { blocks, text } = orderPostedBlocks(base);
    expect(text).toContain("<@UBUYER>");
    const actions = blocks.find((b) => b.type === "actions")!;
    expect(JSON.stringify(actions)).toContain("order_fulfill");
    expect(JSON.stringify(actions)).toContain("order_cancel");
    expect(JSON.stringify(actions)).toContain("confirm");
    expect(JSON.stringify(actions)).toContain(base.orderId);
  });
});

describe("orderFulfilledBlocks", () => {
  it("has no action buttons and names admin", () => {
    const { blocks } = orderFulfilledBlocks({ ...base, fulfilledByAdminId: "UADMIN" });
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
    expect(JSON.stringify(blocks)).toContain("<@UADMIN>");
  });
});

describe("orderCancelledBlocks", () => {
  it("admin variant names admin", () => {
    const { blocks } = orderCancelledBlocks({ ...base, cancelledByAdminId: "UADMIN" });
    expect(JSON.stringify(blocks)).toContain("<@UADMIN>");
  });
  it("buyer self-cancel variant says 'buyer'", () => {
    const { blocks } = orderCancelledBlocks({ ...base, cancelledByAdminId: null });
    expect(JSON.stringify(blocks)).toContain("by buyer");
  });
});

describe("DM strings", () => {
  it("purchase confirmation includes balance hint", () => {
    expect(purchaseConfirmationDm("Mug", 10, 40, "taco")).toContain("40");
  });
  it("fulfill DM names admin", () => {
    expect(orderFulfilledDm("Mug", "UADMIN", "taco")).toContain("<@UADMIN>");
  });
  it("self-cancel DM says 'by you'", () => {
    expect(orderCancelledDm("Mug", 10, null, "taco")).toContain("by you");
  });
  it("admin-cancel DM names admin", () => {
    expect(orderCancelledDm("Mug", 10, "UADMIN", "taco")).toContain("<@UADMIN>");
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm vitest run tests/unit/format-orders.test.ts
git add lib/slack/format.ts tests/unit/format-orders.test.ts
git commit -m "feat(slack): block kit + DM strings for shop orders"
```

### Task 5.2: Receiver interactivity parsing

**Files:**
- Modify: `lib/slack/receiver.ts`

- [ ] **Step 1: Decode form-urlencoded payload**

Replace the JSON parse section with content-type-aware decoding:

```ts
let parsed: unknown;
const contentType = req.headers.get("content-type") ?? "";
try {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(rawBody);
    const payload = form.get("payload");
    if (!payload) return new Response("missing payload", { status: 400 });
    parsed = JSON.parse(payload);
  } else {
    parsed = JSON.parse(rawBody);
  }
} catch {
  return new Response("invalid body", { status: 400 });
}
```

- [ ] **Step 2: Commit (tests follow in 5.3)**

```bash
git add lib/slack/receiver.ts
git commit -m "feat(slack): parse interactivity payload (form-urlencoded)"
```

### Task 5.3: Receiver interactivity test

**Files:**
- Modify: `tests/unit/receiver-verify.test.ts` OR create `tests/integration/receiver-interactivity.test.ts`
- Create: `tests/integration/receiver-interactivity.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { AppRouterReceiver } from "@/lib/slack/receiver";

function sign(secret: string, ts: string, body: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return `v0=${hmac}`;
}

describe("AppRouterReceiver interactivity", () => {
  it("routes form-urlencoded payload to processEvent", async () => {
    const secret = "test_secret";
    const recv = new AppRouterReceiver(secret);
    const processEvent = vi.fn().mockResolvedValue(undefined);
    recv.init({ processEvent } as unknown as Parameters<typeof recv.init>[0]);

    const payload = JSON.stringify({ type: "block_actions", actions: [{ action_id: "order_fulfill", value: "abc" }], user: { id: "UADMIN" } });
    const body = `payload=${encodeURIComponent(payload)}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = new Request("https://x/api/slack/events", {
      method: "POST", body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(secret, ts, body),
      },
    });

    const res = await recv.handle(req);
    expect(res.status).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects bad signature", async () => {
    const recv = new AppRouterReceiver("real_secret");
    recv.init({ processEvent: vi.fn() } as unknown as Parameters<typeof recv.init>[0]);
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = new Request("https://x/api/slack/events", {
      method: "POST", body: "payload=%7B%7D",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=bogus",
      },
    });
    const res = await recv.handle(req);
    expect(res.status).toBe(401);
  });

  it("rejects replayed timestamp", async () => {
    const secret = "sec";
    const recv = new AppRouterReceiver(secret);
    recv.init({ processEvent: vi.fn() } as unknown as Parameters<typeof recv.init>[0]);
    const ts = (Math.floor(Date.now() / 1000) - 60 * 10).toString();
    const body = "payload=%7B%7D";
    const req = new Request("https://x/api/slack/events", {
      method: "POST", body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(secret, ts, body),
      },
    });
    const res = await recv.handle(req);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm vitest run tests/integration/receiver-interactivity.test.ts
git add tests/integration/receiver-interactivity.test.ts
git commit -m "test(slack): cover interactivity payload + signature + replay"
```

### Task 5.4: Bolt order action handlers

**Files:**
- Create: `lib/slack/handlers/orderActions.ts`
- Modify: `lib/slack/handlers.ts`

- [ ] **Step 1: Handler**

```ts
// lib/slack/handlers/orderActions.ts
import type { App } from "@slack/bolt";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, items, users } from "@/lib/db/schema";
import { fulfillOrder } from "@/lib/shop/fulfill";
import { cancelOrder } from "@/lib/shop/cancel";
import { config } from "@/lib/config";
import {
  orderFulfilledBlocks, orderCancelledBlocks, orderPostedBlocks,
  orderFulfilledDm, orderCancelledDm,
} from "@/lib/slack/format";
import type { Order } from "@/lib/db/schema";

async function loadOrderContext(orderId: string) {
  const [row] = await db
    .select({
      order: orders,
      itemName: items.name,
      imageUrl: items.imageUrl,
      redemptionInstructions: items.redemptionInstructions,
    })
    .from(orders)
    .innerJoin(items, eq(orders.itemId, items.id))
    .where(eq(orders.id, orderId));
  return row;
}

function blocksFor(order: Order, itemName: string, imageUrl: string | null, instructions: string | null) {
  const base = {
    orderId: order.id,
    buyerUserId: order.userId,
    itemName,
    price: order.pricePaid,
    imageUrl,
    redemptionInstructions: instructions,
    emojiName: config.taco.confirmationEmojiName,
  };
  if (order.status === "fulfilled") {
    return orderFulfilledBlocks({ ...base, fulfilledByAdminId: order.fulfilledByAdminId! });
  }
  if (order.status === "cancelled") {
    return orderCancelledBlocks({ ...base, cancelledByAdminId: order.cancelledByAdminId });
  }
  return orderPostedBlocks(base);
}

export function registerOrderActionHandlers(app: App) {
  app.action("order_fulfill", async ({ ack, body, action, client, respond }) => {
    await ack();
    const userId = (body as { user: { id: string } }).user.id;
    if (!config.admin.slackIds.includes(userId)) {
      await respond({ response_type: "ephemeral", text: "Not authorized." });
      return;
    }
    const orderId = (action as { value: string }).value;
    const result = await fulfillOrder(db, { orderId, adminId: userId });
    const ctx = await loadOrderContext(orderId);
    if (!ctx) return;
    const order = result.kind === "ok" ? result.order : ctx.order;
    try {
      await client.chat.update({
        channel: order.slackChannelId!,
        ts: order.slackMessageTs!,
        ...blocksFor(order, ctx.itemName, ctx.imageUrl, ctx.redemptionInstructions),
      });
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
    if (result.kind === "ok") {
      try {
        await client.chat.postMessage({
          channel: order.userId,
          text: orderFulfilledDm(ctx.itemName, userId, config.taco.confirmationEmojiName),
        });
      } catch (err) {
        console.error("[orderActions] DM failed", err);
      }
    } else {
      await respond({ response_type: "ephemeral", text: `Order is already ${order.status}.` });
    }
  });

  app.action("order_cancel", async ({ ack, body, action, client, respond }) => {
    await ack();
    const userId = (body as { user: { id: string } }).user.id;
    if (!config.admin.slackIds.includes(userId)) {
      await respond({ response_type: "ephemeral", text: "Not authorized." });
      return;
    }
    const orderId = (action as { value: string }).value;
    const result = await cancelOrder(db, { orderId, actor: { kind: "admin", userId } });
    const ctx = await loadOrderContext(orderId);
    if (!ctx) return;
    const order = result.kind === "ok" ? result.order : ctx.order;
    try {
      await client.chat.update({
        channel: order.slackChannelId!,
        ts: order.slackMessageTs!,
        ...blocksFor(order, ctx.itemName, ctx.imageUrl, ctx.redemptionInstructions),
      });
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
    if (result.kind === "ok") {
      try {
        await client.chat.postMessage({
          channel: order.userId,
          text: orderCancelledDm(ctx.itemName, order.pricePaid, userId, config.taco.confirmationEmojiName),
        });
      } catch (err) {
        console.error("[orderActions] DM failed", err);
      }
    } else {
      await respond({ response_type: "ephemeral", text: `Order is already ${order.status}.` });
    }
  });
}
```

- [ ] **Step 2: Wire into `handlers.ts`**

In `registerAllHandlers()`, add: `registerOrderActionHandlers(app);` (import at top).

- [ ] **Step 3: Commit**

```bash
git add lib/slack/handlers/orderActions.ts lib/slack/handlers.ts
git commit -m "feat(slack): order_fulfill + order_cancel block_actions"
```

---

## Phase 6 — Auth changes

### Task 6.1: Relax `signIn`, auto-insert user

**Files:**
- Modify: `lib/auth.ts`

- [ ] **Step 1: Update callback**

Replace `signIn`:
```ts
async signIn({ profile }) {
  const slackUserId = pickSlackUserId(profile);
  if (!slackUserId) return false;
  // Ensure user exists + is active. Insert on first sign-in (no-op upsert if present).
  const { db } = await import("@/lib/db/client");
  const { users } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const profileName =
    (profile as { name?: string })?.name ??
    (profile as { given_name?: string })?.given_name ??
    slackUserId;
  await db
    .insert(users)
    .values({
      id: slackUserId,
      name: profileName,
      dailyRemaining: appConfig.taco.dailyAllowance,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { isActive: true, updatedAt: new Date() },
    });
  const [u] = await db.select().from(users).where(eq(users.id, slackUserId));
  return Boolean(u?.isActive);
},
```

- [ ] **Step 2: Move admin gate into `app/admin/layout.tsx`** — covered in Task 7.

- [ ] **Step 3: Commit**

```bash
git add lib/auth.ts
git commit -m "feat(auth): admit any active user; insert on first sign-in"
```

---

## Phase 7 — Admin layout gate + nav

### Task 7.1: Admin allowlist redirect

**Files:**
- Modify: `app/admin/layout.tsx`

- [ ] **Step 1: Edit layout**

Read the file first, then add the admin gate:

```ts
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
// ...
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/api/auth/signin?callbackUrl=/admin");
  const slackUserId = (session as { slackUserId?: string }).slackUserId;
  if (!slackUserId || !config.admin.slackIds.includes(slackUserId)) {
    redirect("/shop?err=admin_only");
  }
  // existing nav + children rendering
  return /* … keep existing layout JSX; add Orders link in nav … */;
}
```

Add a nav link `<Link href="/admin/orders">Orders</Link>` alongside Users / Items / Activity / Leaderboard.

- [ ] **Step 2: Commit**

```bash
git add app/admin/layout.tsx
git commit -m "feat(admin): allowlist gate at layout + Orders nav link"
```

---

## Phase 8 — `/admin/orders` page

### Task 8.1: List query helper

**Files:**
- Modify: `lib/db/queries.ts`

- [ ] **Step 1: Add `listOrders`, `getOrderById`**

```ts
import { orders } from "@/lib/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";

export async function listOrders(db: DbLike, opts: {
  status?: "pending" | "fulfilled" | "cancelled";
  userId?: string;
  itemId?: string;
  cursor?: { createdAt: Date; id: string };
  limit?: number;
}) {
  const limit = opts.limit ?? 50;
  const conds = [];
  if (opts.status) conds.push(eq(orders.status, opts.status));
  if (opts.userId) conds.push(eq(orders.userId, opts.userId));
  if (opts.itemId) conds.push(eq(orders.itemId, opts.itemId));
  if (opts.cursor) conds.push(lt(orders.createdAt, opts.cursor.createdAt));
  return db
    .select()
    .from(orders)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(limit + 1);
}

export async function getOrderById(db: DbLike, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row ?? null;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/db/queries.ts
git commit -m "feat(db): listOrders / getOrderById helpers"
```

### Task 8.2: Page + actions

**Files:**
- Create: `app/admin/orders/page.tsx`
- Create: `app/admin/orders/actions.ts`

- [ ] **Step 1: actions.ts**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { fulfillOrder } from "@/lib/shop/fulfill";
import { cancelOrder } from "@/lib/shop/cancel";
import { getBoltApp } from "@/lib/slack/bolt";
import { getOrderById } from "@/lib/db/queries";
import { items } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  orderFulfilledBlocks, orderCancelledBlocks,
  orderFulfilledDm, orderCancelledDm,
} from "@/lib/slack/format";

async function requireAdminId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId || !config.admin.slackIds.includes(slackId)) throw new Error("unauthorized");
  return slackId;
}

async function loadItemMeta(itemId: string) {
  const [it] = await db.select().from(items).where(eq(items.id, itemId));
  return it;
}

export async function fulfillOrderAction(formData: FormData) {
  const adminId = await requireAdminId();
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("missing order_id");
  const r = await fulfillOrder(db, { orderId, adminId });
  const order = await getOrderById(db, orderId);
  if (order && order.slackChannelId && order.slackMessageTs) {
    const it = await loadItemMeta(order.itemId);
    try {
      await getBoltApp().client.chat.update({
        channel: order.slackChannelId,
        ts: order.slackMessageTs,
        ...orderFulfilledBlocks({
          orderId: order.id, buyerUserId: order.userId,
          itemName: order.itemNameSnap, price: order.pricePaid,
          imageUrl: it?.imageUrl, redemptionInstructions: order.redemptionInstructionsSnap,
          emojiName: config.taco.confirmationEmojiName,
          fulfilledByAdminId: order.fulfilledByAdminId ?? adminId,
        }),
      });
    } catch (err) { console.error("chat.update failed", err); }
  }
  if (r.kind === "ok" && order) {
    try {
      await getBoltApp().client.chat.postMessage({
        channel: order.userId,
        text: orderFulfilledDm(order.itemNameSnap, adminId, config.taco.confirmationEmojiName),
      });
    } catch (err) { console.error("DM failed", err); }
  }
  if (r.kind === "not_pending") throw new Error("Order is not pending anymore");
  revalidatePath("/admin/orders");
}

export async function cancelOrderAction(formData: FormData) {
  const adminId = await requireAdminId();
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("missing order_id");
  const r = await cancelOrder(db, { orderId, actor: { kind: "admin", userId: adminId } });
  const order = await getOrderById(db, orderId);
  if (order && order.slackChannelId && order.slackMessageTs) {
    const it = await loadItemMeta(order.itemId);
    try {
      await getBoltApp().client.chat.update({
        channel: order.slackChannelId,
        ts: order.slackMessageTs,
        ...orderCancelledBlocks({
          orderId: order.id, buyerUserId: order.userId,
          itemName: order.itemNameSnap, price: order.pricePaid,
          imageUrl: it?.imageUrl, redemptionInstructions: order.redemptionInstructionsSnap,
          emojiName: config.taco.confirmationEmojiName,
          cancelledByAdminId: order.cancelledByAdminId,
        }),
      });
    } catch (err) { console.error("chat.update failed", err); }
  }
  if (r.kind === "ok" && order) {
    try {
      await getBoltApp().client.chat.postMessage({
        channel: order.userId,
        text: orderCancelledDm(order.itemNameSnap, order.pricePaid, adminId, config.taco.confirmationEmojiName),
      });
    } catch (err) { console.error("DM failed", err); }
  }
  if (r.kind === "not_pending") throw new Error("Order is not pending anymore");
  revalidatePath("/admin/orders");
}
```

- [ ] **Step 2: page.tsx**

```tsx
import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { listOrders } from "@/lib/db/queries";
import { fulfillOrderAction, cancelOrderAction } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = (sp.status as "pending" | "fulfilled" | "cancelled" | undefined) ?? "pending";
  const rows = await listOrders(db, { status });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Orders</h1>
      <nav className="flex gap-3 text-sm">
        {(["pending", "fulfilled", "cancelled"] as const).map((s) => (
          <a key={s} href={`/admin/orders?status=${s}`}
            className={s === status ? "font-semibold underline" : "text-gray-600"}>
            {s}
          </a>
        ))}
      </nav>
      <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
        <thead className="text-left text-sm text-gray-600">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Buyer</th>
            <th className="px-4 py-3">Item</th>
            <th className="px-4 py-3">Price</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-sm">
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="px-4 py-3 text-gray-500">{o.createdAt.toISOString()}</td>
              <td className="px-4 py-3">{o.userId}</td>
              <td className="px-4 py-3">{o.itemNameSnap}</td>
              <td className="px-4 py-3">{o.pricePaid} 🌮</td>
              <td className="px-4 py-3">{o.status}</td>
              <td className="px-4 py-3">
                {o.status === "pending" ? (
                  <div className="flex gap-2">
                    <form action={fulfillOrderAction}>
                      <input type="hidden" name="order_id" value={o.id} />
                      <button className="rounded bg-green-600 px-3 py-1 text-white">Fulfill</button>
                    </form>
                    <form action={cancelOrderAction}>
                      <input type="hidden" name="order_id" value={o.id} />
                      <button className="rounded bg-red-600 px-3 py-1 text-white">Cancel</button>
                    </form>
                  </div>
                ) : (
                  <span className="text-gray-500">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/admin/orders/page.tsx app/admin/orders/actions.ts
git commit -m "feat(admin): orders list page + fulfill/cancel actions"
```

---

## Phase 9 — `/shop` rebuild

### Task 9.1: Server actions

**Files:**
- Create: `app/shop/actions.ts`

- [ ] **Step 1: buyItem + cancelMyOrder**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { purchase } from "@/lib/shop/purchase";
import { cancelOrder } from "@/lib/shop/cancel";
import { getOrderById } from "@/lib/db/queries";
import { items, users } from "@/lib/db/schema";
import { getBoltApp } from "@/lib/slack/bolt";
import {
  orderPostedBlocks, orderCancelledBlocks,
  purchaseConfirmationDm, orderCancelledDm,
} from "@/lib/slack/format";

async function requireUserId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId) throw new Error("unauthenticated");
  return slackId;
}

export async function buyItem(formData: FormData) {
  if (!config.shopSelfServeEnabled) redirect("/shop?err=disabled");
  const userId = await requireUserId();
  const itemId = String(formData.get("item_id") ?? "");
  if (!itemId) redirect("/shop?err=missing");

  const r = await purchase(db, { userId, itemId });
  if (r.kind !== "ok") {
    redirect(`/shop?err=${r.kind}`);
  }
  const order = r.order;

  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  try {
    const channel = config.tacoshopChannelId;
    const post = await getBoltApp().client.chat.postMessage({
      channel,
      ...orderPostedBlocks({
        orderId: order.id, buyerUserId: order.userId,
        itemName: order.itemNameSnap, price: order.pricePaid,
        imageUrl: item?.imageUrl, redemptionInstructions: order.redemptionInstructionsSnap,
        emojiName: config.taco.confirmationEmojiName,
      }),
    });
    if (post.ok && post.ts) {
      await db.update((await import("@/lib/db/schema")).orders)
        .set({ slackChannelId: channel, slackMessageTs: post.ts })
        .where(eq((await import("@/lib/db/schema")).orders.id, order.id));
    }
  } catch (err) { console.error("post to tacoshop failed", err); }

  try {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    await getBoltApp().client.chat.postMessage({
      channel: userId,
      text: purchaseConfirmationDm(order.itemNameSnap, order.pricePaid, u?.balance ?? 0, config.taco.confirmationEmojiName),
    });
  } catch (err) { console.error("buyer DM failed", err); }

  revalidatePath("/shop");
  redirect(`/shop?ok=${order.id}`);
}

export async function cancelMyOrder(formData: FormData) {
  if (!config.shopSelfServeEnabled) redirect("/shop?err=disabled");
  const userId = await requireUserId();
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) redirect("/shop?err=missing");
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId || order.status !== "pending") {
    redirect("/shop?err=not_pending");
  }
  const r = await cancelOrder(db, { orderId, actor: { kind: "buyer", userId } });
  if (r.kind === "forbidden") redirect("/shop?err=forbidden");
  if (r.kind === "not_pending") redirect("/shop?err=not_pending");

  if (order.slackChannelId && order.slackMessageTs) {
    try {
      const [it] = await db.select().from(items).where(eq(items.id, order.itemId));
      await getBoltApp().client.chat.update({
        channel: order.slackChannelId,
        ts: order.slackMessageTs,
        ...orderCancelledBlocks({
          orderId: order.id, buyerUserId: order.userId,
          itemName: order.itemNameSnap, price: order.pricePaid,
          imageUrl: it?.imageUrl, redemptionInstructions: order.redemptionInstructionsSnap,
          emojiName: config.taco.confirmationEmojiName,
          cancelledByAdminId: null,
        }),
      });
    } catch (err) { console.error("chat.update failed", err); }
  }
  try {
    await getBoltApp().client.chat.postMessage({
      channel: userId,
      text: orderCancelledDm(order.itemNameSnap, order.pricePaid, null, config.taco.confirmationEmojiName),
    });
  } catch (err) { console.error("DM failed", err); }

  revalidatePath("/shop");
  redirect(`/shop?cancelled=${order.id}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add app/shop/actions.ts
git commit -m "feat(shop): buyItem + cancelMyOrder server actions"
```

### Task 9.2: Shop page rebuild

**Files:**
- Modify: `app/shop/page.tsx`

- [ ] **Step 1: Replace page**

```tsx
import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { listActiveItems } from "@/lib/db/queries";
import { orders, users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { buyItem, cancelMyOrder } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Shop" };

export default async function ShopPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const items = await listActiveItems(db);
  const session = await auth();
  const slackId = (session as { slackUserId?: string } | null)?.slackUserId ?? null;
  const me = slackId ? (await db.select().from(users).where(eq(users.id, slackId)))[0] : null;
  const pending = slackId
    ? await db
        .select()
        .from(orders)
        .where(and(eq(orders.userId, slackId), eq(orders.status, "pending")))
    : [];

  const channelLink = `https://slack.com/app_redirect?channel=${config.tacoshopChannelId}`;
  const flagOn = config.shopSelfServeEnabled;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">🌮 Tacobot Shop</h1>
        <p className="mt-2 text-gray-600">
          Earn tacos by being recognized in <code>#taqueria</code>.{" "}
          {flagOn && slackId ? (
            <>Click <em>Buy</em> on an item to redeem.</>
          ) : flagOn ? (
            <>
              <a href="/api/auth/signin?callbackUrl=/shop" className="font-medium text-amber-700 hover:underline">Sign in with Slack</a> to buy items.
            </>
          ) : null}{" "}
          Prefer Slack? <a href={channelLink} className="font-medium text-amber-700 hover:underline">Post your order in #tacoshop</a>.
        </p>
        {me && flagOn ? (
          <p className="mt-2 text-sm text-gray-600">
            Signed in as <strong>{me.name}</strong> · Balance: <strong>{me.balance} 🌮</strong> ·{" "}
            <a href="/api/auth/signout?callbackUrl=/shop" className="underline">Sign out</a>
          </p>
        ) : null}
        {sp.err ? <p className="mt-2 text-sm text-red-600">Error: {sp.err}</p> : null}
        {sp.ok ? <p className="mt-2 text-sm text-green-700">Order placed.</p> : null}
        {sp.cancelled ? <p className="mt-2 text-sm text-amber-700">Order cancelled.</p> : null}
      </header>

      {flagOn && pending.length > 0 ? (
        <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-lg font-semibold">Your pending orders</h2>
          <ul className="space-y-2">
            {pending.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{o.itemNameSnap} · {o.pricePaid} 🌮 · {o.createdAt.toLocaleString()}</span>
                <form action={cancelMyOrder}
                  onSubmit={(e) => { if (!confirm("Cancel this order?")) e.preventDefault(); }}>
                  <input type="hidden" name="order_id" value={o.id} />
                  <button className="rounded bg-red-100 px-3 py-1 text-red-800">Cancel</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {items.length === 0 ? (
        <p className="text-gray-500">No items available right now. Check back later.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {items.map((it) => {
            const soldOut = it.quantity !== null && it.quantity <= 0;
            const cantAfford = flagOn && me ? me.balance < it.priceTacos : false;
            const disabled = !flagOn || !slackId || soldOut || cantAfford;
            return (
              <li key={it.id} className="rounded-lg border border-gray-200 p-4">
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.imageUrl} alt="" className="mb-3 h-40 w-full rounded object-cover" />
                ) : null}
                <div className="flex items-start justify-between gap-4">
                  <h2 className="text-lg font-semibold">{it.name}</h2>
                  <span className="whitespace-nowrap rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
                    {it.priceTacos} 🌮
                  </span>
                </div>
                {it.description ? <p className="mt-2 text-sm text-gray-600">{it.description}</p> : null}
                {it.quantity !== null ? <p className="mt-2 text-xs text-gray-500">{it.quantity} available</p> : null}
                {flagOn ? (
                  <form action={buyItem} className="mt-3">
                    <input type="hidden" name="item_id" value={it.id} />
                    <button disabled={disabled}
                      className="w-full rounded bg-amber-500 px-3 py-2 text-white disabled:bg-gray-300">
                      {soldOut ? "Sold out" : cantAfford ? "Not enough 🌮" : !slackId ? "Sign in to buy" : `Buy for ${it.priceTacos} 🌮`}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
```

Note: the `<form onSubmit>` JSX requires a Client component for the inline handler. Refactor cancel button into a small client island OR drop the confirm and just allow direct submit. We will keep it server-side and drop the inline `onSubmit`; users get a single-click cancel (idempotent on server side).

Replace the Cancel form block with:
```tsx
<form action={cancelMyOrder}>
  <input type="hidden" name="order_id" value={o.id} />
  <button className="rounded bg-red-100 px-3 py-1 text-red-800">Cancel</button>
</form>
```

- [ ] **Step 2: Commit**

```bash
git add app/shop/page.tsx
git commit -m "feat(shop): auth gate, Buy buttons, pending-orders panel, #tacoshop link"
```

---

## Phase 10 — Docs + env

### Task 10.1: README + .env.example + CLAUDE.md + slack-setup

**Files:**
- Modify: `README.md`, `.env.example`, `CLAUDE.md`, `docs/slack-setup.md`

- [ ] **Step 1: README env table** — add `SHOP_SELF_SERVE_ENABLED`, `TACOSHOP_CHANNEL_ID` rows. User-facing blurb about self-serve shop.

- [ ] **Step 2: CLAUDE.md** — add invariants entry for `orders` table + redeem/grant shape wrinkles + new file paths + new env vars + new "Where things live" rows.

- [ ] **Step 3: slack-setup.md** — enable Interactivity & Shortcuts; Request URL = `/api/slack/events`; invite bot to `#tacoshop`.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example CLAUDE.md docs/slack-setup.md
git commit -m "docs: shop self-serve env + slack interactivity + CLAUDE.md updates"
```

---

## Phase 11 — Verify

### Task 11.1: typecheck + lint + tests

- [ ] **Step 1: Run CI commands**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass.

If failures: fix inline; commit each fix individually.

- [ ] **Step 2: Final commit (only if fixes needed)**

```bash
git add -A
git commit -m "fix: address typecheck/lint/test fallout for shop self-serve"
```
