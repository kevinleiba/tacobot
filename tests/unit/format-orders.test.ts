import { describe, it, expect } from "vitest";
import {
  orderPostedBlocks,
  orderFulfilledBlocks,
  orderCancelledBlocks,
  purchaseConfirmationDm,
  orderFulfilledDm,
  orderCancelledDm,
} from "@/lib/slack/format";

const base = {
  orderId: "11111111-2222-3333-4444-555555555555",
  buyerUserId: "UBUYER",
  itemName: "Mug",
  price: 10,
  emojiName: "taco",
};

describe("orderPostedBlocks", () => {
  it("includes buyer mention, price, both action buttons with order id and confirm dialog", () => {
    const { blocks, text } = orderPostedBlocks(base);
    expect(text).toContain("<@UBUYER>");
    expect(text).toContain(":taco:");
    const actions = blocks.find(
      (b) => (b as { type: string }).type === "actions",
    ) as { elements: unknown[] };
    const serialised = JSON.stringify(actions);
    expect(serialised).toContain("order_fulfill");
    expect(serialised).toContain("order_cancel");
    expect(serialised).toContain("confirm");
    expect(serialised).toContain(base.orderId);
  });

  it("renders redemption instructions in context line", () => {
    const { blocks } = orderPostedBlocks({
      ...base,
      redemptionInstructions: "ask Pat",
    });
    expect(JSON.stringify(blocks)).toContain("ask Pat");
  });

  it("includes image accessory when provided", () => {
    const { blocks } = orderPostedBlocks({
      ...base,
      imageUrl: "https://example.com/mug.png",
    });
    expect(JSON.stringify(blocks)).toContain("https://example.com/mug.png");
  });
});

describe("orderFulfilledBlocks", () => {
  it("has no action buttons and names admin", () => {
    const { blocks } = orderFulfilledBlocks({
      ...base,
      fulfilledByAdminId: "UADMIN",
    });
    expect(
      blocks.find((b) => (b as { type: string }).type === "actions"),
    ).toBeUndefined();
    expect(JSON.stringify(blocks)).toContain("<@UADMIN>");
  });
});

describe("orderCancelledBlocks", () => {
  it("admin variant names admin", () => {
    const { blocks } = orderCancelledBlocks({
      ...base,
      cancelledByAdminId: "UADMIN",
    });
    expect(JSON.stringify(blocks)).toContain("<@UADMIN>");
  });

  it("buyer self-cancel variant says 'buyer'", () => {
    const { blocks } = orderCancelledBlocks({
      ...base,
      cancelledByAdminId: null,
    });
    expect(JSON.stringify(blocks)).toContain("by buyer");
  });
});

describe("DM strings", () => {
  it("purchase confirmation includes balance hint", () => {
    expect(purchaseConfirmationDm("Mug", 10, 40, "taco")).toContain("40");
  });
  it("fulfill DM names admin", () => {
    expect(orderFulfilledDm("Mug", "UADMIN", "taco")).toContain("<@UADMIN>");
  });
  it("self-cancel DM says 'by you'", () => {
    expect(orderCancelledDm("Mug", 10, null, "taco")).toContain("by you");
  });
  it("admin-cancel DM names admin", () => {
    expect(orderCancelledDm("Mug", 10, "UADMIN", "taco")).toContain(
      "<@UADMIN>",
    );
  });
});
