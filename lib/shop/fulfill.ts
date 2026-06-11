import { and, eq, sql } from "drizzle-orm";
import { orders } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { Order } from "@/lib/db/schema";

export type FulfillInput = { orderId: string; adminId: string };
export type FulfillResult =
  | { kind: "ok"; order: Order }
  | { kind: "not_pending" };

/**
 * Idempotent state transition pending -> fulfilled. Atomic WHERE guard
 * makes a re-click on an already-fulfilled order return not_pending
 * instead of double-flipping.
 */
export async function fulfillOrder(
  db: DbLike,
  input: FulfillInput,
): Promise<FulfillResult> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({
        status: "fulfilled",
        fulfilledAt: sql`now()`,
        fulfilledByAdminId: input.adminId,
      })
      .where(
        and(eq(orders.id, input.orderId), eq(orders.status, "pending")),
      )
      .returning();
    if (updated.length === 0) return { kind: "not_pending" } as const;
    return { kind: "ok", order: updated[0] } as const;
  });
}
