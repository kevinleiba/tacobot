"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { grant } from "@/lib/admin/grant";
import { redeem } from "@/lib/admin/redeem";
import { getBoltApp } from "@/lib/slack/bolt";
import { grantNotificationMessage } from "@/lib/slack/format";

async function requireAdminId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId) throw new Error("unauthorized");
  return slackId;
}

export async function deductTacos(formData: FormData) {
  const adminId = await requireAdminId();
  const employeeId = String(formData.get("employee_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  const amountRaw = String(formData.get("amount") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!employeeId || !itemId) throw new Error("missing fields");
  const amount = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");

  const result = await redeem(db, { employeeId, itemId, amount, adminId, reason });
  if (result.kind === "insufficient") {
    throw new Error("Employee has insufficient balance for that amount");
  }
  revalidatePath("/admin/users");
}

export async function adjustTacos(formData: FormData) {
  const adminId = await requireAdminId();
  const recipientId = String(formData.get("recipient_id") ?? "");
  const amountRaw = String(formData.get("amount") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!recipientId) throw new Error("missing recipient");
  const amount = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("amount must be a non-zero integer");
  }

  await grant(db, { recipientId, amount, adminId, reason });

  // Best-effort DM. The DB write has already committed; if Slack is down or
  // the user has DMs disabled, log and move on rather than throwing.
  try {
    await getBoltApp().client.chat.postMessage({
      channel: recipientId,
      text: grantNotificationMessage(
        amount,
        reason,
        config.shopUrl,
        config.taco.confirmationEmojiName,
      ),
    });
  } catch (err) {
    console.error("grant DM failed", err);
  }

  revalidatePath("/admin/users");
}
