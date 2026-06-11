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

class PurchaseAbort extends Error {
  constructor(
    public reason: "unavailable" | "out_of_stock" | "insufficient",
  ) {
    super(reason);
  }
}

/**
 * Atomic self-serve purchase:
 *   FOR UPDATE on the item row, conditional UPDATE on stock + balance,
 *   then insert order + redeem ledger row, finally patch order.redeemTxId.
 * Any partial failure throws PurchaseAbort which rolls back the whole
 * transaction; the outer catch converts it back to a typed result.
 */
export async function purchase(
  db: DbLike,
  input: PurchaseInput,
): Promise<PurchaseResult> {
  try {
    return await db.transaction(async (tx) => {
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
      if (!item) throw new PurchaseAbort("unavailable");

      if (item.quantity !== null) {
        const dec = await tx
          .update(items)
          .set({
            quantity: sql`${items.quantity} - 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(items.id, item.id), gte(items.quantity, 1)))
          .returning({ id: items.id });
        if (dec.length === 0) throw new PurchaseAbort("out_of_stock");
      }

      const debited = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${item.priceTacos}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(users.id, input.userId), gte(users.balance, item.priceTacos)),
        )
        .returning({ id: users.id });
      if (debited.length === 0) throw new PurchaseAbort("insufficient");

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
  } catch (err) {
    if (err instanceof PurchaseAbort) {
      return { kind: err.reason } as const;
    }
    throw err;
  }
}
