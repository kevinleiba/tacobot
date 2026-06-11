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

/**
 * Atomic pending -> cancelled with refund. Restores balance + stock,
 * inserts a grant ledger row (orderId set; adminUserId null for buyer
 * self-cancel). The `actor` discriminator records who initiated.
 */
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
      .set({
        balance: sql`${users.balance} + ${order.pricePaid}`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, order.userId));

    await tx
      .update(items)
      .set({
        quantity: sql`${items.quantity} + 1`,
        updatedAt: sql`now()`,
      })
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
