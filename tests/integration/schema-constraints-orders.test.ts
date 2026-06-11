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

describe("orders CHECK constraints", () => {
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
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM orders`);
      const rows = (result as unknown as { rows: { n: number }[] }).rows;
      expect(rows[0].n).toBe(1);
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
