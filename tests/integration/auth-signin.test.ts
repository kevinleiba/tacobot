import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, inRollbackTx } from "./helpers/db";
import { users } from "@/lib/db/schema";
import { signInLogic } from "@/lib/auth-signin";

describe("signInLogic", () => {
  beforeAll(async () => {
    await getDb();
  });

  it("admits an active user already in DB", async () => {
    await inRollbackTx(async (tx) => {
      await tx.insert(users).values({
        id: "UACTIVE",
        name: "Active",
        dailyRemaining: 5,
        isActive: true,
      });
      const ok = await signInLogic(tx, { sub: "UACTIVE", name: "Active" }, 5);
      expect(ok).toBe(true);
    });
  });

  it("admits a brand-new user (auto-inserts) and counts them active", async () => {
    await inRollbackTx(async (tx) => {
      const ok = await signInLogic(
        tx,
        { sub: "UNEW", name: "Newcomer" },
        5,
      );
      expect(ok).toBe(true);
      const [u] = await tx.select().from(users).where(eq(users.id, "UNEW"));
      expect(u.isActive).toBe(true);
      expect(u.name).toBe("Newcomer");
    });
  });

  it("reactivates a deactivated user on next sign-in", async () => {
    await inRollbackTx(async (tx) => {
      await tx.insert(users).values({
        id: "UDEACT",
        name: "Old",
        dailyRemaining: 5,
        isActive: false,
      });
      const ok = await signInLogic(tx, { sub: "UDEACT", name: "Old" }, 5);
      expect(ok).toBe(true);
      const [u] = await tx.select().from(users).where(eq(users.id, "UDEACT"));
      expect(u.isActive).toBe(true);
    });
  });

  it("rejects when slack user id missing from profile", async () => {
    await inRollbackTx(async (tx) => {
      const ok = await signInLogic(tx, { name: "anon" }, 5);
      expect(ok).toBe(false);
    });
  });

  it("prefers Slack workspace claim over sub", async () => {
    await inRollbackTx(async (tx) => {
      const ok = await signInLogic(
        tx,
        {
          sub: "global-sub",
          "https://slack.com/user_id": "UWORKSPACE",
          name: "Workspace User",
        },
        5,
      );
      expect(ok).toBe(true);
      const [u] = await tx
        .select()
        .from(users)
        .where(eq(users.id, "UWORKSPACE"));
      expect(u).toBeDefined();
    });
  });

  it("falls back to given_name when name absent", async () => {
    await inRollbackTx(async (tx) => {
      await signInLogic(
        tx,
        { sub: "UFIRSTNAME", given_name: "First" },
        5,
      );
      const [u] = await tx
        .select()
        .from(users)
        .where(eq(users.id, "UFIRSTNAME"));
      expect(u.name).toBe("First");
    });
  });
});
