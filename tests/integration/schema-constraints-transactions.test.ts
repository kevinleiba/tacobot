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

describe("transactions shape_and_rule CHECK (relaxed)", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("rejects redeem with neither admin nor order", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await expect(
        tx.insert(transactions).values({
          type: "redeem",
          toUserId: "UBUYER",
          itemId,
          amount: 10,
        }),
      ).rejects.toThrow();
    });
  });

  it("accepts redeem with admin only (admin manual deduct)", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "redeem",
        toUserId: "UBUYER",
        adminUserId: "UADMIN",
        itemId,
        amount: 10,
      });
    });
  });

  it("accepts redeem with order only (self-serve)", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId, orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "redeem",
        toUserId: "UBUYER",
        itemId,
        amount: 10,
        orderId,
      });
    });
  });

  it("rejects redeem with both admin and order", async () => {
    await inRollbackTx(async (tx) => {
      const { itemId, orderId } = await seed(tx);
      await expect(
        tx.insert(transactions).values({
          type: "redeem",
          toUserId: "UBUYER",
          adminUserId: "UADMIN",
          itemId,
          amount: 10,
          orderId,
        }),
      ).rejects.toThrow();
    });
  });

  it("accepts grant admin-only (onboarding)", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      await tx.insert(transactions).values({
        type: "grant",
        toUserId: "UBUYER",
        adminUserId: "UADMIN",
        amount: 5,
      });
    });
  });

  it("accepts grant with order only (self-cancel refund)", async () => {
    await inRollbackTx(async (tx) => {
      const { orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "grant",
        toUserId: "UBUYER",
        amount: 10,
        orderId,
      });
    });
  });

  it("accepts grant with admin + order (admin cancel refund)", async () => {
    await inRollbackTx(async (tx) => {
      const { orderId } = await seed(tx);
      await tx.insert(transactions).values({
        type: "grant",
        toUserId: "UBUYER",
        adminUserId: "UADMIN",
        amount: 10,
        orderId,
      });
    });
  });

  it("rejects grant with neither admin nor order", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      await expect(
        tx.insert(transactions).values({
          type: "grant",
          toUserId: "UBUYER",
          amount: 5,
        }),
      ).rejects.toThrow();
    });
  });

  it("preserves give: rejects give with orderId set", async () => {
    await inRollbackTx(async (tx) => {
      const { orderId } = await seed(tx);
      await expect(
        tx.insert(transactions).values({
          type: "give",
          toUserId: "UBUYER",
          fromUserId: "UADMIN",
          amount: 1,
          orderId,
        }),
      ).rejects.toThrow();
    });
  });
});
