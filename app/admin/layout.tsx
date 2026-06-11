import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: {
    default: `Admin · Tacobot - ${config.companyName}`,
    template: `%s · Tacobot Admin - ${config.companyName}`,
  },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) {
    // Trigger Slack sign-in.
    redirect("/api/auth/signin?callbackUrl=/admin");
  }
  const slackUserId = (session as { slackUserId?: string }).slackUserId;
  if (!slackUserId || !config.admin.slackIds.includes(slackUserId)) {
    // Non-admins sign in fine; they just can't see admin pages.
    redirect("/shop?err=admin_only");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/admin" className="text-lg font-semibold">🌮 Tacobot Admin</Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/admin/activity" className="text-gray-700 hover:text-gray-900">Activity</Link>
            <Link href="/admin/leaderboard" className="text-gray-700 hover:text-gray-900">Leaderboard</Link>
            <Link href="/admin/users" className="text-gray-700 hover:text-gray-900">Users</Link>
            <Link href="/admin/items" className="text-gray-700 hover:text-gray-900">Items</Link>
            <Link href="/admin/orders" className="text-gray-700 hover:text-gray-900">Orders</Link>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button type="submit" className="text-gray-500 hover:text-gray-700">Sign out</button>
            </form>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
