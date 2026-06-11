import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, transactions, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";

type Tx = Awaited<ReturnType<typeof getDb>>;

async function seed(
  tx: Tx,
  opts?: { balance?: number; quantity?: number | null; price?: number },
) {
  const balance = opts?.balance ?? 50;
  const quantity = opts?.quantity === undefined ? 3 : opts.quantity;
  const price = opts?.price ?? 10;
  await tx.insert(users).values({
    id: "UBUYER",
    name: "Buyer",
    dailyRemaining: 5,
    balance,
    receivedTotal: balance,
  });
  const [item] = await tx
    .insert(items)
    .values({
      name: "Mug",
      description: "ceramic",
      redemptionInstructions: "ask Pat",
      priceTacos: price,
      quantity,
    })
    .returning();
  return { itemId: item.id, price, quantity, balance };
}

describe("purchase()", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("happy path: debits balance, decrements stock, inserts order + redeem tx with snapshots", async () => {
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

      const [t] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.orderId, o.id));
      expect(t.type).toBe("redeem");
      expect(t.adminUserId).toBeNull();
      expect(t.amount).toBe(price);
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
      const oRows = await tx.select().from(orders);
      expect(oRows.length).toBe(0);
    });
  });

  it("boundary: balance === price → ok, ends at 0", async () => {
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

  it("snapshots stay frozen after subsequent item edits", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      const r = await purchase(tx, { userId: "UBUYER", itemId });
      if (r.kind !== "ok") throw new Error("seed failed");
      await tx
        .update(items)
        .set({
          name: "Renamed",
          description: "updated",
          redemptionInstructions: "new instructions",
          priceTacos: 999,
        })
        .where(eq(items.id, itemId));
      const [o] = await tx.select().from(orders).where(eq(orders.id, r.order.id));
      expect(o.itemNameSnap).toBe("Mug");
      expect(o.descriptionSnap).toBe("ceramic");
      expect(o.redemptionInstructionsSnap).toBe("ask Pat");
      expect(o.pricePaid).toBe(10);
    });
  });
});
