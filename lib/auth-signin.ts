import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";

/**
 * Pure-logic core of the Auth.js `signIn` callback, kept in its own module
 * so unit tests can import it without pulling in `next-auth` (which depends
 * on Next.js server runtime symbols that vitest can't resolve).
 *
 * Admits any active Slack user; auto-inserts on first sign-in and
 * reactivates a deactivated row.
 */
export async function signInLogic(
  db: DbLike,
  profile: unknown,
  dailyAllowance: number,
): Promise<boolean> {
  const slackUserId = pickSlackUserId(profile);
  if (!slackUserId) return false;
  const profileName = pickProfileName(profile) ?? slackUserId;
  await db
    .insert(users)
    .values({
      id: slackUserId,
      name: profileName,
      dailyRemaining: dailyAllowance,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { isActive: true, updatedAt: new Date() },
    });
  const [u] = await db.select().from(users).where(eq(users.id, slackUserId));
  return Boolean(u?.isActive);
}

export function pickSlackUserId(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  const fromTeam = p["https://slack.com/user_id"];
  if (typeof fromTeam === "string") return fromTeam;
  if (typeof p.sub === "string") return p.sub;
  return undefined;
}

export function pickProfileName(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  if (typeof p.name === "string") return p.name;
  if (typeof p.given_name === "string") return p.given_name;
  return undefined;
}
