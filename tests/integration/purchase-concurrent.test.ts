import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withCleanDb } from "./helpers/db";
import { items, orders, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";

type Tx = Awaited<ReturnType<typeof getDb>>;

async function seedItem(
  db: Tx,
  opts: { quantity: number | null; price: number },
) {
  const [item] = await db
    .insert(items)
    .values({
      name: "Race-" + crypto.randomUUID().slice(0, 6),
      priceTacos: opts.price,
      quantity: opts.quantity,
    })
    .returning();
  return item.id;
}

async function seedUser(db: Tx, id: string, balance: number) {
  await db.insert(users).values({
    id,
    name: id,
    dailyRemaining: 5,
    balance,
    receivedTotal: balance,
  });
}

describe("purchase() concurrency", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("stock=1, two parallel purchases by different buyers → exactly one ok", async () => {
    await withCleanDb(async (db) => {
      const itemId = await seedItem(db, { quantity: 1, price: 10 });
      await Promise.all([
        seedUser(db, "URACE_A", 100),
        seedUser(db, "URACE_B", 100),
      ]);
      const results = await Promise.all([
        purchase(db, { userId: "URACE_A", itemId }),
        purchase(db, { userId: "URACE_B", itemId }),
      ]);
      const ok = results.filter((r) => r.kind === "ok").length;
      const oos = results.filter((r) => r.kind === "out_of_stock").length;
      expect(ok).toBe(1);
      expect(oos).toBe(1);
      const [it] = await db.select().from(items).where(eq(items.id, itemId));
      expect(it.quantity).toBe(0);
      const oRows = await db.select().from(orders);
      expect(oRows.length).toBe(1);
    });
  });

  it("stock=2, three parallel purchases → exactly two ok and one out_of_stock", async () => {
    await withCleanDb(async (db) => {
      const itemId = await seedItem(db, { quantity: 2, price: 10 });
      await Promise.all([
        seedUser(db, "URACE_A", 100),
        seedUser(db, "URACE_B", 100),
        seedUser(db, "URACE_C", 100),
      ]);
      const results = await Promise.all([
        purchase(db, { userId: "URACE_A", itemId }),
        purchase(db, { userId: "URACE_B", itemId }),
        purchase(db, { userId: "URACE_C", itemId }),
      ]);
      expect(results.filter((r) => r.kind === "ok").length).toBe(2);
      expect(results.filter((r) => r.kind === "out_of_stock").length).toBe(1);
      const [it] = await db.select().from(items).where(eq(items.id, itemId));
      expect(it.quantity).toBe(0);
    });
  });

  it("single buyer with balance=N, price=N, two parallel purchases → exactly one debit", async () => {
    await withCleanDb(async (db) => {
      const itemId = await seedItem(db, { quantity: null, price: 10 });
      await seedUser(db, "USOLO", 10);
      const results = await Promise.all([
        purchase(db, { userId: "USOLO", itemId }),
        purchase(db, { userId: "USOLO", itemId }),
      ]);
      expect(results.filter((r) => r.kind === "ok").length).toBe(1);
      expect(results.filter((r) => r.kind === "insufficient").length).toBe(1);
      const [u] = await db.select().from(users).where(eq(users.id, "USOLO"));
      expect(u.balance).toBe(0);
    });
  });
});
