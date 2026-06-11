import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, transactions, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";
import { cancelOrder } from "@/lib/shop/cancel";
import { fulfillOrder } from "@/lib/shop/fulfill";

type Tx = Awaited<ReturnType<typeof getDb>>;

async function setup(tx: Tx, opts?: { quantity?: number | null }) {
  await tx.insert(users).values([
    {
      id: "UBUYER",
      name: "Buyer",
      dailyRemaining: 5,
      balance: 50,
      receivedTotal: 50,
    },
    { id: "UADMIN", name: "Admin", dailyRemaining: 5 },
    { id: "UOTHER", name: "Other", dailyRemaining: 5 },
  ]);
  const [item] = await tx
    .insert(items)
    .values({
      name: "Mug",
      priceTacos: 10,
      quantity: opts?.quantity === undefined ? 3 : opts.quantity,
    })
    .returning();
  const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
  if (r.kind !== "ok") throw new Error("seed failed");
  return { order: r.order, item };
}

describe("cancelOrder()", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("admin cancel: restores balance + stock + inserts admin grant", async () => {
    await inRollbackTx(async (tx) => {
      const { order, item } = await setup(tx);
      const r = await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      expect(r.kind).toBe("ok");

      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBe(50);
      const [it] = await tx.select().from(items).where(eq(items.id, item.id));
      expect(it.quantity).toBe(3);
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("cancelled");
      expect(o.cancelledByAdminId).toBe("UADMIN");
      expect(o.refundTxId).not.toBeNull();
      const [t] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, o.refundTxId!));
      expect(t.type).toBe("grant");
      expect(t.adminUserId).toBe("UADMIN");
      expect(t.amount).toBe(10);
      expect(t.orderId).toBe(order.id);
    });
  });

  it("buyer self-cancel: admin fields null on order + grant", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const r = await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "buyer", userId: "UBUYER" },
      });
      expect(r.kind).toBe("ok");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.cancelledByAdminId).toBeNull();
      const [t] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, o.refundTxId!));
      expect(t.adminUserId).toBeNull();
      expect(t.orderId).toBe(order.id);
    });
  });

  it("forbidden: another buyer cannot self-cancel", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      const r = await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "buyer", userId: "UOTHER" },
      });
      expect(r.kind).toBe("forbidden");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("pending");
    });
  });

  it("cancelled → fulfill rejected", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      const r = await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      expect(r.kind).toBe("not_pending");
    });
  });

  it("double-cancel rejected", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      const r = await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      expect(r.kind).toBe("not_pending");
    });
  });

  it("null-quantity item: stock stays null", async () => {
    await inRollbackTx(async (tx) => {
      const { order, item } = await setup(tx, { quantity: null });
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      const [it] = await tx.select().from(items).where(eq(items.id, item.id));
      expect(it.quantity).toBeNull();
    });
  });

  it("ledger net-zero after purchase + cancel", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      const txs = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.toUserId, "UBUYER"));
      const sum = txs.reduce(
        (acc, r) => acc + (r.type === "redeem" ? -r.amount : r.amount),
        0,
      );
      expect(sum).toBe(0);
    });
  });

  it("preserves balance ≤ receivedTotal invariant", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setup(tx);
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "buyer", userId: "UBUYER" },
      });
      const [u] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      expect(u.balance).toBeLessThanOrEqual(u.receivedTotal);
    });
  });
});
