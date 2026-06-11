"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { purchase } from "@/lib/shop/purchase";
import { cancelOrder } from "@/lib/shop/cancel";
import { getOrderById } from "@/lib/db/queries";
import { items, orders, users } from "@/lib/db/schema";
import { getBoltApp } from "@/lib/slack/bolt";
import {
  orderPostedBlocks,
  orderCancelledBlocks,
  purchaseConfirmationDm,
  orderCancelledDm,
} from "@/lib/slack/format";

async function requireUserId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId) throw new Error("unauthenticated");
  return slackId;
}

export async function buyItem(formData: FormData): Promise<never> {
  if (!config.shopSelfServeEnabled) redirect("/shop?err=disabled");
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    redirect("/api/auth/signin?callbackUrl=/shop");
  }
  const itemId = String(formData.get("item_id") ?? "");
  if (!itemId) redirect("/shop?err=missing");

  const result = await purchase(db, { userId, itemId });
  if (result.kind !== "ok") {
    redirect(`/shop?err=${result.kind}`);
  }
  const order = result.order;

  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  try {
    const channel = config.tacoshopChannelId;
    const view = orderPostedBlocks({
      orderId: order.id,
      buyerUserId: order.userId,
      itemName: order.itemNameSnap,
      price: order.pricePaid,
      imageUrl: item?.imageUrl,
      redemptionInstructions: order.redemptionInstructionsSnap,
      emojiName: config.taco.confirmationEmojiName,
    });
    const client = getBoltApp().client;
    const post = await client.chat.postMessage({
      channel,
      text: view.text,
      blocks: view.blocks,
    } as Parameters<typeof client.chat.postMessage>[0]);
    if (post.ok && post.ts) {
      await db
        .update(orders)
        .set({ slackChannelId: channel, slackMessageTs: post.ts })
        .where(eq(orders.id, order.id));
    }
  } catch (err) {
    console.error("[shop/buyItem] post to tacoshop failed", err);
  }

  try {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    await getBoltApp().client.chat.postMessage({
      channel: userId,
      text: purchaseConfirmationDm(
        order.itemNameSnap,
        order.pricePaid,
        u?.balance ?? 0,
        config.taco.confirmationEmojiName,
      ),
    });
  } catch (err) {
    console.error("[shop/buyItem] buyer DM failed", err);
  }

  revalidatePath("/shop");
  redirect(`/shop?ok=${order.id}`);
}

export async function cancelMyOrder(formData: FormData): Promise<never> {
  if (!config.shopSelfServeEnabled) redirect("/shop?err=disabled");
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    redirect("/api/auth/signin?callbackUrl=/shop");
  }
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) redirect("/shop?err=missing");

  const existing = await getOrderById(db, orderId);
  if (!existing) redirect("/shop?err=not_found");
  if (existing.userId !== userId) redirect("/shop?err=forbidden");
  if (existing.status !== "pending") redirect("/shop?err=not_pending");

  const result = await cancelOrder(db, {
    orderId,
    actor: { kind: "buyer", userId },
  });
  if (result.kind === "forbidden") redirect("/shop?err=forbidden");
  if (result.kind === "not_pending") redirect("/shop?err=not_pending");

  if (existing.slackChannelId && existing.slackMessageTs) {
    try {
      const [it] = await db.select().from(items).where(eq(items.id, existing.itemId));
      const view = orderCancelledBlocks({
        orderId: existing.id,
        buyerUserId: existing.userId,
        itemName: existing.itemNameSnap,
        price: existing.pricePaid,
        imageUrl: it?.imageUrl,
        redemptionInstructions: existing.redemptionInstructionsSnap,
        emojiName: config.taco.confirmationEmojiName,
        cancelledByAdminId: null,
      });
      const client = getBoltApp().client;
      await client.chat.update({
        channel: existing.slackChannelId,
        ts: existing.slackMessageTs,
        text: view.text,
        blocks: view.blocks,
      } as Parameters<typeof client.chat.update>[0]);
    } catch (err) {
      console.error("[shop/cancelMyOrder] chat.update failed", err);
    }
  }

  try {
    await getBoltApp().client.chat.postMessage({
      channel: userId,
      text: orderCancelledDm(
        existing.itemNameSnap,
        existing.pricePaid,
        null,
        config.taco.confirmationEmojiName,
      ),
    });
  } catch (err) {
    console.error("[shop/cancelMyOrder] DM failed", err);
  }

  revalidatePath("/shop");
  redirect(`/shop?cancelled=${existing.id}`);
}
