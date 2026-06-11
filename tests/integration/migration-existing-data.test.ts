import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, transactions, users } from "@/lib/db/schema";

type Tx = Awaited<ReturnType<typeof getDb>>;

/**
 * Simulates the shape of pre-migration data and asserts that every existing
 * row shape would still satisfy the relaxed `transactions_shape_and_rule`
 * CHECK (`order_id` is always NULL on old rows) and the relaxed
 * `items_quantity_nonneg` CHECK.
 *
 * If this suite ever fails, the migration is NOT safe to apply blindly to
 * production — there's an existing row that would be rejected.
 */
describe("migration safety: existing-shape rows must satisfy new CHECKs", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("legacy give row (fromUser, no admin/order/item/reversal) still passes", async () => {
    await inRollbackTx(async (tx) => {
      await seedTwoUsers(tx);
      await tx.insert(transactions).values({
        type: "give",
        toUserId: "UA",
        fromUserId: "UB",
        amount: 1,
        slackChannelId: "C1",
        slackMessageTs: "1.0",
      });
    });
  });

  it("legacy redeem row (admin set, no order) still passes", async () => {
    await inRollbackTx(async (tx) => {
      await seedTwoUsers(tx);
      const [it] = await tx
        .insert(items)
        .values({ name: "Mug", priceTacos: 10 })
        .returning();
      await tx.insert(transactions).values({
        type: "redeem",
        toUserId: "UA",
        adminUserId: "UB",
        itemId: it.id,
        amount: 10,
      });
    });
  });

  it("legacy grant row (admin set, no order) still passes", async () => {
    await inRollbackTx(async (tx) => {
      await seedTwoUsers(tx);
      await tx.insert(transactions).values({
        type: "grant",
        toUserId: "UA",
        adminUserId: "UB",
        amount: 5,
        reason: "starter pack",
      });
    });
  });

  it("legacy reversal row still passes", async () => {
    await inRollbackTx(async (tx) => {
      await seedTwoUsers(tx);
      const [give] = await tx
        .insert(transactions)
        .values({
          type: "give",
          toUserId: "UA",
          fromUserId: "UB",
          amount: 1,
        })
        .returning();
      await tx.insert(transactions).values({
        type: "reversal",
        toUserId: "UA",
        amount: 1,
        reversedTransactionId: give.id,
      });
    });
  });

  it("legacy items.quantity values (NULL and >0) still pass the relaxed CHECK", async () => {
    await inRollbackTx(async (tx) => {
      await tx.insert(items).values([
        { name: "UnlimitedMug", priceTacos: 1, quantity: null },
        { name: "FiniteMug", priceTacos: 1, quantity: 3 },
      ]);
      const r = await tx.execute(
        sql`SELECT count(*)::int AS n FROM items WHERE name LIKE '%Mug'`,
      );
      const rows = (r as unknown as { rows: { n: number }[] }).rows;
      expect(rows[0].n).toBe(2);
    });
  });

  it("items.quantity = 0 (sold-out, new state) is now allowed", async () => {
    await inRollbackTx(async (tx) => {
      await tx
        .insert(items)
        .values({ name: "SoldOut", priceTacos: 1, quantity: 0 });
    });
  });

  it("items.quantity = -1 still rejected", async () => {
    await inRollbackTx(async (tx) => {
      await expect(
        tx.insert(items).values({
          name: "Negative",
          priceTacos: 1,
          quantity: -1,
        }),
      ).rejects.toThrow();
    });
  });
});

async function seedTwoUsers(tx: Tx) {
  await tx.insert(users).values([
    { id: "UA", name: "A", dailyRemaining: 5 },
    { id: "UB", name: "B", dailyRemaining: 5 },
  ]);
}
