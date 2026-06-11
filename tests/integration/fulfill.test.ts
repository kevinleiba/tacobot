import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, transactions, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";
import { fulfillOrder } from "@/lib/shop/fulfill";

type Tx = Awaited<ReturnType<typeof getDb>>;

async function setup(tx: Tx) {
  await tx.insert(users).values([
    {
      id: "UBUYER",
      name: "Buyer",
      dailyRemaining: 5,
      balance: 50,
      receivedTotal: 50,
    },
    { id: "UADMIN", name: "Admin", dailyRemaining: 5 },
  ]);
  const [item] = await tx
    .insert(items)
    .values({ name: "Mug", priceTacos: 10, quantity: 3 })
    .returning();
  const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
  if (r.kind !== "ok") throw new Error("seed purchase failed");
  return { order: r.order, item };
}

describe("fulfillOrder()", () => {
  beforeAll(async () => {
    await getDb();
  });

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
      const [beforeUser] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      const [beforeItem] = await tx.select().from(items).where(eq(items.id, item.id));
      await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      const [afterUser] = await tx.select().from(users).where(eq(users.id, "UBUYER"));
      const [afterItem] = await tx.select().from(items).where(eq(items.id, item.id));
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
