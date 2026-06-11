import type { GivePlan } from "./give";
import type { ReversedItem } from "./reverse";

export function overAllowanceMessage(
  demand: number,
  remaining: number,
  emojiName: string,
): string {
  return `:${emojiName}: You've only got ${remaining} taco${remaining === 1 ? "" : "s"} left today; that would need ${demand}. Try again tomorrow.`;
}

export function giveSuccessGiverMessage(plan: GivePlan, remainingAfter: number): string {
  const lines = plan.transactions.map(
    (t) => `<@${t.toUserId}> received ${t.amount} taco${t.amount === 1 ? "" : "s"} from you.`,
  );
  lines.push(
    `You have ${remainingAfter} taco${remainingAfter === 1 ? "" : "s"} left to give out today.`,
  );
  return lines.join("\n");
}

export function giveSuccessRecipientMessage(
  giverId: string,
  amount: number,
  channelId: string,
): string {
  return `You received ${amount} taco${amount === 1 ? "" : "s"} from <@${giverId}> in <#${channelId}>.`;
}

// Neutral wording: a deleter's text-mention give and a reactor's reaction-give
// can both end up reversed by the same `message_deleted` event, so the DM has
// to read correctly for both audiences (the actor of the original give isn't
// always the deleter).
export function messageDeletedGiverMessage(
  items: ReversedItem[],
  channelId: string,
  emojiName: string,
): string {
  const lines = items.map(
    (i) => `<@${i.recipientId}> lost ${i.amount} taco${i.amount === 1 ? "" : "s"}.`,
  );
  return [
    `:${emojiName}: A message in <#${channelId}> was deleted; the tacos you gave in connection with it were taken back:`,
    ...lines,
  ].join("\n");
}

export function messageDeletedRecipientMessage(
  giverId: string,
  amount: number,
  channelId: string,
  emojiName: string,
): string {
  return `:${emojiName}: A message in <#${channelId}> was deleted; ${amount} taco${amount === 1 ? "" : "s"} you received from <@${giverId}> ${amount === 1 ? "was" : "were"} taken back.`;
}

export function reactionRemovedReactorMessage(
  items: { recipientId: string; amount: number }[],
  channelId: string,
  emojiName: string,
): string {
  const emoji = `:${emojiName}:`;
  if (items.length === 1) {
    const { recipientId, amount } = items[0];
    return `${emoji} You removed your ${emoji} reaction in <#${channelId}>; ${amount} taco${amount === 1 ? "" : "s"} ${amount === 1 ? "was" : "were"} taken back from <@${recipientId}>.`;
  }
  const lines = items.map(
    (i) => `<@${i.recipientId}> lost ${i.amount} taco${i.amount === 1 ? "" : "s"}.`,
  );
  return [
    `${emoji} You removed your ${emoji} reaction in <#${channelId}>; reversed:`,
    ...lines,
  ].join("\n");
}

// Recipient-facing DM for an admin balance adjustment. Branches on sign:
// positive grants get warm onboarding wording with a shop link; negative
// grants get neutral "adjusted" wording. Optional `reason` is appended on a
// new line.
export function grantNotificationMessage(
  amount: number,
  reason: string | null,
  shopUrl: string,
  emojiName: string,
): string {
  const reasonLine = reason ? `\nNote: ${reason}` : "";
  if (amount > 0) {
    return `:${emojiName}: You received ${amount} taco${amount === 1 ? "" : "s"} from an admin to spend in the shop: ${shopUrl}${reasonLine}`;
  }
  const abs = Math.abs(amount);
  return `:${emojiName}: An admin adjusted your taco balance by ${amount} taco${abs === 1 ? "" : "s"}.${reasonLine}`;
}

export function reactionRemovedRecipientMessage(
  reactorId: string,
  amount: number,
  channelId: string,
  emojiName: string,
): string {
  const emoji = `:${emojiName}:`;
  return `${emoji} <@${reactorId}> removed their ${emoji} reaction in <#${channelId}>; ${amount} taco${amount === 1 ? "" : "s"} you received from them ${amount === 1 ? "was" : "were"} taken back.`;
}

// =================== Shop order block kit + DM strings ====================

export type OrderBlocksInput = {
  orderId: string;
  buyerUserId: string;
  itemName: string;
  price: number;
  imageUrl?: string | null;
  redemptionInstructions?: string | null;
  emojiName: string;
};

const shortOrderId = (id: string) => id.slice(0, 8);

function headerSection(input: OrderBlocksInput) {
  const accessory = input.imageUrl
    ? {
        type: "image" as const,
        image_url: input.imageUrl,
        alt_text: input.itemName,
      }
    : undefined;
  return {
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: `<@${input.buyerUserId}> ordered *${input.itemName}* for *${input.price} :${input.emojiName}:*`,
    },
    ...(accessory ? { accessory } : {}),
  };
}

export function orderPostedBlocks(
  input: OrderBlocksInput,
): { blocks: unknown[]; text: string } {
  const text = `<@${input.buyerUserId}> ordered ${input.itemName} for ${input.price} :${input.emojiName}:`;
  const instructions = input.redemptionInstructions
    ? ` · ${input.redemptionInstructions}`
    : "";
  const blocks: unknown[] = [
    headerSection(input),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Order \`${shortOrderId(input.orderId)}\` · pending${instructions}`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "order_fulfill",
          value: input.orderId,
          text: { type: "plain_text", text: "Mark fulfilled" },
          style: "primary",
        },
        {
          type: "button",
          action_id: "order_cancel",
          value: input.orderId,
          text: { type: "plain_text", text: "Cancel & refund" },
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Cancel order?" },
            text: {
              type: "mrkdwn",
              text: `Refund *${input.price} :${input.emojiName}:* to <@${input.buyerUserId}>?`,
            },
            confirm: { type: "plain_text", text: "Cancel order" },
            deny: { type: "plain_text", text: "Keep" },
          },
        },
      ],
    },
  ];
  return { blocks, text };
}

export function orderFulfilledBlocks(
  input: OrderBlocksInput & { fulfilledByAdminId: string },
): { blocks: unknown[]; text: string } {
  const text = `Order ${input.itemName} fulfilled`;
  const blocks: unknown[] = [
    headerSection(input),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Order \`${shortOrderId(input.orderId)}\` · ✅ fulfilled by <@${input.fulfilledByAdminId}>`,
        },
      ],
    },
  ];
  return { blocks, text };
}

export function orderCancelledBlocks(
  input: OrderBlocksInput & { cancelledByAdminId: string | null },
): { blocks: unknown[]; text: string } {
  const by = input.cancelledByAdminId
    ? `<@${input.cancelledByAdminId}>`
    : "buyer";
  const text = `Order ${input.itemName} cancelled`;
  const blocks: unknown[] = [
    headerSection(input),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Order \`${shortOrderId(input.orderId)}\` · ❌ cancelled by ${by} · ${input.price} :${input.emojiName}: refunded`,
        },
      ],
    },
  ];
  return { blocks, text };
}

export function purchaseConfirmationDm(
  itemName: string,
  price: number,
  balanceAfter: number,
  emojiName: string,
): string {
  return `:${emojiName}: You ordered *${itemName}* for *${price}*. Balance: *${balanceAfter}*.`;
}

export function orderFulfilledDm(
  itemName: string,
  adminId: string,
  emojiName: string,
): string {
  return `:${emojiName}: Your *${itemName}* order was fulfilled by <@${adminId}>.`;
}

export function orderCancelledDm(
  itemName: string,
  price: number,
  cancelledByAdminId: string | null,
  emojiName: string,
): string {
  const by = cancelledByAdminId ? `<@${cancelledByAdminId}>` : "you";
  return `:${emojiName}: Your *${itemName}* order was cancelled by ${by}. *${price}* refunded.`;
}
