import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, items } from "@/lib/db/schema";
import type { Order } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
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

export type SlackClient = {
  chat: {
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks: unknown[];
    }) => Promise<unknown>;
    postMessage: (args: {
      channel: string;
      text: string;
    }) => Promise<unknown>;
  };
};

export type RespondFn = (args: {
  response_type: "ephemeral";
  text: string;
}) => Promise<unknown>;

export type HandlerDeps = {
  db: DbLike;
  client: SlackClient;
  respond: RespondFn;
  adminSlackIds: string[];
  emojiName: string;
};

async function loadOrderContext(
  db: DbLike,
  orderId: string,
): Promise<OrderContext | null> {
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

function blocksFor(ctx: OrderContext, emojiName: string) {
  const base = {
    orderId: ctx.order.id,
    buyerUserId: ctx.order.userId,
    itemName: ctx.itemName,
    price: ctx.order.pricePaid,
    imageUrl: ctx.imageUrl,
    redemptionInstructions: ctx.redemptionInstructions,
    emojiName,
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

/**
 * Core handler for the #tacoshop "Mark fulfilled" button. Extracted from the
 * Bolt registration so unit tests can drive it with a mocked SlackClient.
 */
export async function handleOrderFulfillAction(
  deps: HandlerDeps,
  input: { slackUserId: string; orderId: string },
): Promise<void> {
  if (!deps.adminSlackIds.includes(input.slackUserId)) {
    await deps.respond({ response_type: "ephemeral", text: "Not authorized." });
    return;
  }
  const result = await fulfillOrder(deps.db, {
    orderId: input.orderId,
    adminId: input.slackUserId,
  });
  const ctx = await loadOrderContext(deps.db, input.orderId);
  if (!ctx) return;
  const view = blocksFor(ctx, deps.emojiName);
  if (ctx.order.slackChannelId && ctx.order.slackMessageTs) {
    try {
      await deps.client.chat.update({
        channel: ctx.order.slackChannelId,
        ts: ctx.order.slackMessageTs,
        text: view.text,
        blocks: view.blocks,
      });
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
  }
  if (result.kind === "ok") {
    try {
      await deps.client.chat.postMessage({
        channel: ctx.order.userId,
        text: orderFulfilledDm(ctx.itemName, input.slackUserId, deps.emojiName),
      });
    } catch (err) {
      console.error("[orderActions] fulfill DM failed", err);
    }
  } else {
    await deps.respond({
      response_type: "ephemeral",
      text: `Order is already ${ctx.order.status}.`,
    });
  }
}

/**
 * Core handler for the #tacoshop "Cancel & refund" button. Same shape as
 * `handleOrderFulfillAction`.
 */
export async function handleOrderCancelAction(
  deps: HandlerDeps,
  input: { slackUserId: string; orderId: string },
): Promise<void> {
  if (!deps.adminSlackIds.includes(input.slackUserId)) {
    await deps.respond({ response_type: "ephemeral", text: "Not authorized." });
    return;
  }
  const result = await cancelOrder(deps.db, {
    orderId: input.orderId,
    actor: { kind: "admin", userId: input.slackUserId },
  });
  const ctx = await loadOrderContext(deps.db, input.orderId);
  if (!ctx) return;
  const view = blocksFor(ctx, deps.emojiName);
  if (ctx.order.slackChannelId && ctx.order.slackMessageTs) {
    try {
      await deps.client.chat.update({
        channel: ctx.order.slackChannelId,
        ts: ctx.order.slackMessageTs,
        text: view.text,
        blocks: view.blocks,
      });
    } catch (err) {
      console.error("[orderActions] chat.update failed", err);
    }
  }
  if (result.kind === "ok") {
    try {
      await deps.client.chat.postMessage({
        channel: ctx.order.userId,
        text: orderCancelledDm(
          ctx.itemName,
          ctx.order.pricePaid,
          input.slackUserId,
          deps.emojiName,
        ),
      });
    } catch (err) {
      console.error("[orderActions] cancel DM failed", err);
    }
  } else if (result.kind === "not_pending") {
    await deps.respond({
      response_type: "ephemeral",
      text: `Order is already ${ctx.order.status}.`,
    });
  }
}

export function registerOrderActionHandlers(app: App): void {
  app.action("order_fulfill", async ({ ack, body, action, client, respond }) => {
    await ack();
    await handleOrderFulfillAction(
      {
        db,
        client: client as unknown as SlackClient,
        respond: respond as unknown as RespondFn,
        adminSlackIds: config.admin.slackIds,
        emojiName: config.taco.confirmationEmojiName,
      },
      {
        slackUserId: (body as { user: { id: string } }).user.id,
        orderId: (action as { value: string }).value,
      },
    );
  });

  app.action("order_cancel", async ({ ack, body, action, client, respond }) => {
    await ack();
    await handleOrderCancelAction(
      {
        db,
        client: client as unknown as SlackClient,
        respond: respond as unknown as RespondFn,
        adminSlackIds: config.admin.slackIds,
        emojiName: config.taco.confirmationEmojiName,
      },
      {
        slackUserId: (body as { user: { id: string } }).user.id,
        orderId: (action as { value: string }).value,
      },
    );
  });
}
