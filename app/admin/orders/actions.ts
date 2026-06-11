"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { fulfillOrder } from "@/lib/shop/fulfill";
import { cancelOrder } from "@/lib/shop/cancel";
import { getBoltApp } from "@/lib/slack/bolt";
import { getOrderById } from "@/lib/db/queries";
import { items } from "@/lib/db/schema";
import {
  orderFulfilledBlocks,
  orderCancelledBlocks,
  orderFulfilledDm,
  orderCancelledDm,
} from "@/lib/slack/format";

async function requireAdminId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId || !config.admin.slackIds.includes(slackId)) {
    throw new Error("unauthorized");
  }
  return slackId;
}

async function loadItem(itemId: string) {
  const [it] = await db.select().from(items).where(eq(items.id, itemId));
  return it ?? null;
}

export async function fulfillOrderAction(formData: FormData) {
  const adminId = await requireAdminId();
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("missing order_id");

  const result = await fulfillOrder(db, { orderId, adminId });
  const order = await getOrderById(db, orderId);
  if (!order) throw new Error("order not found");

  if (order.slackChannelId && order.slackMessageTs) {
    const it = await loadItem(order.itemId);
    try {
      const view = orderFulfilledBlocks({
        orderId: order.id,
        buyerUserId: order.userId,
        itemName: order.itemNameSnap,
        price: order.pricePaid,
        imageUrl: it?.imageUrl,
        redemptionInstructions: order.redemptionInstructionsSnap,
        emojiName: config.taco.confirmationEmojiName,
        fulfilledByAdminId: order.fulfilledByAdminId ?? adminId,
      });
      const client = getBoltApp().client;
      await client.chat.update({
        channel: order.slackChannelId,
        ts: order.slackMessageTs,
        text: view.text,
        blocks: view.blocks,
      } as Parameters<typeof client.chat.update>[0]);
    } catch (err) {
      console.error("[orders/fulfillAction] chat.update failed", err);
    }
  }

  if (result.kind === "ok") {
    try {
      await getBoltApp().client.chat.postMessage({
        channel: order.userId,
        text: orderFulfilledDm(
          order.itemNameSnap,
          adminId,
          config.taco.confirmationEmojiName,
        ),
      });
    } catch (err) {
      console.error("[orders/fulfillAction] DM failed", err);
    }
  } else {
    throw new Error("Order is not pending anymore");
  }

  revalidatePath("/admin/orders");
}

export async function cancelOrderAction(formData: FormData) {
  const adminId = await requireAdminId();
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("missing order_id");

  const result = await cancelOrder(db, {
    orderId,
    actor: { kind: "admin", userId: adminId },
  });
  const order = await getOrderById(db, orderId);
  if (!order) throw new Error("order not found");

  if (order.slackChannelId && order.slackMessageTs) {
    const it = await loadItem(order.itemId);
    try {
      const view = orderCancelledBlocks({
        orderId: order.id,
        buyerUserId: order.userId,
        itemName: order.itemNameSnap,
        price: order.pricePaid,
        imageUrl: it?.imageUrl,
        redemptionInstructions: order.redemptionInstructionsSnap,
        emojiName: config.taco.confirmationEmojiName,
        cancelledByAdminId: order.cancelledByAdminId,
      });
      const client = getBoltApp().client;
      await client.chat.update({
        channel: order.slackChannelId,
        ts: order.slackMessageTs,
        text: view.text,
        blocks: view.blocks,
      } as Parameters<typeof client.chat.update>[0]);
    } catch (err) {
      console.error("[orders/cancelAction] chat.update failed", err);
    }
  }

  if (result.kind === "ok") {
    try {
      await getBoltApp().client.chat.postMessage({
        channel: order.userId,
        text: orderCancelledDm(
          order.itemNameSnap,
          order.pricePaid,
          adminId,
          config.taco.confirmationEmojiName,
        ),
      });
    } catch (err) {
      console.error("[orders/cancelAction] DM failed", err);
    }
  } else {
    throw new Error("Order is not pending anymore");
  }

  revalidatePath("/admin/orders");
}
