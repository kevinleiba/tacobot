import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";
import { eq } from "drizzle-orm";
import { config as appConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Slack({
      clientId: appConfig.slack.clientId,
      clientSecret: appConfig.slack.clientSecret,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ profile }) {
      const slackUserId = pickSlackUserId(profile);
      if (!slackUserId) return false;
      const profileName = pickProfileName(profile) ?? slackUserId;
      // Insert on first sign-in; reactivate on conflict. Then verify the user
      // is active before admitting.
      await db
        .insert(users)
        .values({
          id: slackUserId,
          name: profileName,
          dailyRemaining: appConfig.taco.dailyAllowance,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: { isActive: true, updatedAt: new Date() },
        });
      const [u] = await db.select().from(users).where(eq(users.id, slackUserId));
      return Boolean(u?.isActive);
    },
    async jwt({ token, profile }) {
      if (profile) {
        const slackUserId = pickSlackUserId(profile);
        if (slackUserId) token.slackUserId = slackUserId;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.slackUserId === "string") {
        (session as { slackUserId?: string }).slackUserId = token.slackUserId;
      }
      return session;
    },
  },
});

function pickSlackUserId(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  const fromTeam = p["https://slack.com/user_id"];
  if (typeof fromTeam === "string") return fromTeam;
  if (typeof p.sub === "string") return p.sub;
  return undefined;
}

function pickProfileName(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  if (typeof p.name === "string") return p.name;
  if (typeof p.given_name === "string") return p.given_name;
  return undefined;
}
