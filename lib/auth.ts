import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";
import { config as appConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  signInLogic,
  pickSlackUserId,
} from "@/lib/auth-signin";

export { signInLogic } from "@/lib/auth-signin";

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
      return signInLogic(db, profile, appConfig.taco.dailyAllowance);
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
