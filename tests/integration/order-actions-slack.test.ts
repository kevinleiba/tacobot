import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { items, orders, users } from "@/lib/db/schema";
import { purchase } from "@/lib/shop/purchase";
import { fulfillOrder } from "@/lib/shop/fulfill";
import { cancelOrder } from "@/lib/shop/cancel";
import {
  handleOrderFulfillAction,
  handleOrderCancelAction,
  type SlackClient,
  type RespondFn,
} from "@/lib/slack/handlers/orderActions";

type Tx = Awaited<ReturnType<typeof getDb>>;

const ADMIN_IDS = ["UADMIN"];

function fakeClient() {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ok: true }),
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies SlackClient;
}

async function setupOrder(tx: Tx) {
  await tx.insert(users).values([
    {
      id: "UBUYER",
      name: "Buyer",
      dailyRemaining: 5,
      balance: 50,
      receivedTotal: 50,
    },
    { id: "UADMIN", name: "Admin", dailyRemaining: 5 },
    { id: "UREG", name: "Regular", dailyRemaining: 5 },
  ]);
  const [item] = await tx
    .insert(items)
    .values({ name: "Mug", priceTacos: 10, quantity: 3 })
    .returning();
  const r = await purchase(tx, { userId: "UBUYER", itemId: item.id });
  if (r.kind !== "ok") throw new Error("seed failed");
  // Pretend Slack post succeeded.
  const [withTs] = await tx
    .update(orders)
    .set({ slackChannelId: "Ctacoshop", slackMessageTs: "1234.5678" })
    .where(eq(orders.id, r.order.id))
    .returning();
  return { order: withTs };
}

describe("handleOrderFulfillAction", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("admin click on pending → state fulfilled, chat.update with fulfilled blocks, buyer DM", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderFulfillAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: order.id },
      );

      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("fulfilled");
      expect(client.chat.update).toHaveBeenCalledOnce();
      const updateArgs = client.chat.update.mock.calls[0]![0];
      expect(JSON.stringify(updateArgs.blocks)).toContain("fulfilled");
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    });
  });

  it("non-admin click → ephemeral Not authorized, state unchanged", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderFulfillAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UREG", orderId: order.id },
      );
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Not authorized." }),
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("pending");
      expect(client.chat.update).not.toHaveBeenCalled();
    });
  });

  it("admin click on already-cancelled order → respond + refresh chat.update with cancelled blocks", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      await cancelOrder(tx, {
        orderId: order.id,
        actor: { kind: "admin", userId: "UADMIN" },
      });
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderFulfillAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: order.id },
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("cancelled");
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Order is already cancelled." }),
      );
      expect(JSON.stringify(client.chat.update.mock.calls[0]![0].blocks)).toContain(
        "cancelled",
      );
    });
  });

  it("chat.update failure: still acks DB state and DMs buyer", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      const client = {
        chat: {
          update: vi.fn().mockRejectedValue(new Error("slack down")),
          postMessage: vi.fn().mockResolvedValue({ ok: true }),
        },
      } satisfies SlackClient;
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderFulfillAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: order.id },
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("fulfilled");
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });
  });
});

describe("handleOrderCancelAction", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("admin click on pending → cancelled, chat.update with admin-variant cancelled blocks, refund DM", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderCancelAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: order.id },
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("cancelled");
      expect(o.cancelledByAdminId).toBe("UADMIN");
      expect(JSON.stringify(client.chat.update.mock.calls[0]![0].blocks)).toContain(
        "<@UADMIN>",
      );
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  it("non-admin click → Not authorized, state unchanged", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderCancelAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UREG", orderId: order.id },
      );
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Not authorized." }),
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("pending");
    });
  });

  it("admin click on already-fulfilled order → respond + refresh blocks", async () => {
    await inRollbackTx(async (tx) => {
      const { order } = await setupOrder(tx);
      await fulfillOrder(tx, { orderId: order.id, adminId: "UADMIN" });
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderCancelAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: order.id },
      );
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe("fulfilled");
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Order is already fulfilled." }),
      );
      expect(JSON.stringify(client.chat.update.mock.calls[0]![0].blocks)).toContain(
        "fulfilled",
      );
    });
  });

  it("unknown order id: no-op without throwing", async () => {
    await inRollbackTx(async (tx) => {
      await setupOrder(tx);
      const client = fakeClient();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleOrderCancelAction(
        {
          db: tx,
          client,
          respond: respond as unknown as RespondFn,
          adminSlackIds: ADMIN_IDS,
          emojiName: "taco",
        },
        { slackUserId: "UADMIN", orderId: crypto.randomUUID() },
      );
      expect(client.chat.update).not.toHaveBeenCalled();
    });
  });
});

