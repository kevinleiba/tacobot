import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, items } from "@/lib/db/schema";
import type { Order } from "@/lib/db/schema";
import { fulfillOrder } from "@/lib/shop/fulfill";
import { cancelOrder } from "@/lib/shop/cancel";
import { config } from "@/lib/config";
import {
  orderFulfilledBlocks,
  orderCancelledBlocks,
  orderPostedBlocks,
  orderFulfilledDm,
  orderCancelledDm,
} from "@/lib/slack/format";

type OrderContext = {
  order: Order;
  itemName: string;
  imageUrl: string | null;
  redemptionInstructions: string | null;
};

async function loadOrderContext(orderId: string): Promise<OrderContext | null> {
  const [row] = await db
    .select({
      order: orders,
      itemName: items.name,
      imageUrl: items.imageUrl,
      redemptionInstructions: items.redemptionInstructions,
    })
    .from(orders)
    .innerJoin(items, eq(orders.itemId, items.id))
    .where(eq(orders.id, orderId));
  return row ?? null;
}

function blocksFor(ctx: OrderContext) {
  const base = {
    orderId: ctx.order.id,
    buyerUserId: ctx.order.userId,
    itemName: ctx.itemName,
    price: ctx.order.pricePaid,
    imageUrl: ctx.imageUrl,
    redemptionInstructions: ctx.redemptionInstructions,
    emojiName: config.taco.confirmationEmojiName,
  };
  if (ctx.order.status === "fulfilled") {
    return orderFulfilledBlocks({
      ...base,
      fulfilledByAdminId: ctx.order.fulfilledByAdminId!,
    });
  }
  if (ctx.order.status === "cancelled") {
    return orderCancelledBlocks({
      ...base,
      cancelledByAdminId: ctx.order.cancelledByAdminId,
    });
  }
  return orderPostedBlocks(base);
}

export function registerOrderActionHandlers(app: App): void {
  app.action("order_fulfill", async ({ ack, body, action, client, respond }) => {
    await ack();
    const slackUserId = (body as { user: { id: string } }).user.id;
    if (!config.admin.slackIds.includes(slackUserId)) {
      await respond({ response_type: "ephemeral", text: "Not authorized." });
      return;
    }
    const orderId = (action as { value: string }).value;
    const result = await fulfillOrder(db, { orderId, adminId: slackUserId });

    const ctx = await loadOrderContext(orderId);
    if (!ctx) return;
    const view = blocksFor(ctx);
    try {
      if (ctx.order.slackChannelId && ctx.order.slackMessageTs) {
        await client.chat.update({
          channel: ctx.order.slackChannelId,
          ts: ctx.order.slackMessageTs,
          text: view.text,
          blocks: view.blocks as Parameters<typeof client.chat.update>[0]["blocks"],
        });
      }
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
    if (result.kind === "ok") {
      try {
        await client.chat.postMessage({
          channel: ctx.order.userId,
          text: orderFulfilledDm(
            ctx.itemName,
            slackUserId,
            config.taco.confirmationEmojiName,
          ),
        });
      } catch (err) {
        console.error("[orderActions] fulfill DM failed", err);
      }
    } else {
      await respond({
        response_type: "ephemeral",
        text: `Order is already ${ctx.order.status}.`,
      });
    }
  });

  app.action("order_cancel", async ({ ack, body, action, client, respond }) => {
    await ack();
    const slackUserId = (body as { user: { id: string } }).user.id;
    if (!config.admin.slackIds.includes(slackUserId)) {
      await respond({ response_type: "ephemeral", text: "Not authorized." });
      return;
    }
    const orderId = (action as { value: string }).value;
    const result = await cancelOrder(db, {
      orderId,
      actor: { kind: "admin", userId: slackUserId },
    });

    const ctx = await loadOrderContext(orderId);
    if (!ctx) return;
    const view = blocksFor(ctx);
    try {
      if (ctx.order.slackChannelId && ctx.order.slackMessageTs) {
        await client.chat.update({
          channel: ctx.order.slackChannelId,
          ts: ctx.order.slackMessageTs,
          text: view.text,
          blocks: view.blocks as Parameters<typeof client.chat.update>[0]["blocks"],
        });
      }
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
    if (result.kind === "ok") {
      try {
        await client.chat.postMessage({
          channel: ctx.order.userId,
          text: orderCancelledDm(
            ctx.itemName,
            ctx.order.pricePaid,
            slackUserId,
            config.taco.confirmationEmojiName,
          ),
        });
      } catch (err) {
        console.error("[orderActions] cancel DM failed", err);
      }
    } else if (result.kind === "not_pending") {
      await respond({
        response_type: "ephemeral",
        text: `Order is already ${ctx.order.status}.`,
      });
    }
  });
}
