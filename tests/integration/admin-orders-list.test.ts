import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, users } from "@/lib/db/schema";
import { listOrders } from "@/lib/db/queries";

type Tx = Awaited<ReturnType<typeof getDb>>;

async function seed(tx: Tx) {
  await tx.insert(users).values([
    { id: "UA", name: "A", dailyRemaining: 5 },
    { id: "UB", name: "B", dailyRemaining: 5 },
  ]);
  const [it1] = await tx
    .insert(items)
    .values({ name: "Mug", priceTacos: 10 })
    .returning();
  const [it2] = await tx
    .insert(items)
    .values({ name: "Hat", priceTacos: 20 })
    .returning();
  // Insert orders chronologically by stepping createdAt back, so the
  // newest-first ordering is predictable in assertions.
  const now = new Date();
  const rows = [
    { user: "UA", item: it1.id, status: "pending" as const, ageMs: 0 },
    { user: "UB", item: it1.id, status: "fulfilled" as const, ageMs: 1000 },
    { user: "UA", item: it2.id, status: "cancelled" as const, ageMs: 2000 },
    { user: "UB", item: it2.id, status: "pending" as const, ageMs: 3000 },
  ];
  const created: { id: string; createdAt: Date }[] = [];
  for (const r of rows) {
    const createdAt = new Date(now.getTime() - r.ageMs);
    const refundTxId = crypto.randomUUID();
    const [o] = await tx
      .insert(orders)
      .values({
        userId: r.user,
        itemId: r.item,
        itemNameSnap: "snap",
        pricePaid: 10,
        status: r.status,
        createdAt,
        ...(r.status === "fulfilled"
          ? { fulfilledAt: createdAt, fulfilledByAdminId: "UA" }
          : {}),
        ...(r.status === "cancelled"
          ? {
              cancelledAt: createdAt,
              refundTxId,
            }
          : {}),
      })
      .returning();
    created.push({ id: o.id, createdAt: o.createdAt });
    void sql; // keep import used
  }
  return { items: [it1.id, it2.id], created };
}

describe("listOrders()", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("filter by status='pending' returns only pending rows", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      const rows = await listOrders(tx, { status: "pending" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
    });
  });

  it("filter by userId returns only that buyer's orders", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      const rows = await listOrders(tx, { userId: "UA" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.userId === "UA")).toBe(true);
    });
  });

  it("filter by itemId returns only that item's orders", async () => {
    await inRollbackTx(async (tx) => {
      const { items: itemIds } = await seed(tx);
      const rows = await listOrders(tx, { itemId: itemIds[0] });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.itemId === itemIds[0])).toBe(true);
    });
  });

  it("default ordering: newest-first by createdAt", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      const rows = await listOrders(tx, {});
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
          rows[i].createdAt.getTime(),
        );
      }
    });
  });

  it("cursor pagination skips earlier rows and stays stable across pages", async () => {
    await inRollbackTx(async (tx) => {
      await seed(tx);
      const page1 = await listOrders(tx, { limit: 2 });
      expect(page1.length).toBe(2);
      const page2 = await listOrders(tx, {
        limit: 2,
        cursor: { createdAt: page1[page1.length - 1].createdAt },
      });
      expect(page2.length).toBe(2);
      const ids = new Set([...page1, ...page2].map((r) => r.id));
      expect(ids.size).toBe(4);
    });
  });
});
