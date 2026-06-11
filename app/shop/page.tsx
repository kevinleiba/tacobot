import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { listActiveItems } from "@/lib/db/queries";
import { orders, users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { buyItem, cancelMyOrder } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shop",
};

type SP = Record<string, string | string[] | undefined>;

function errorMessage(err: string | undefined): string | null {
  if (!err) return null;
  switch (err) {
    case "unavailable":
      return "That item is no longer available.";
    case "out_of_stock":
      return "Sold out.";
    case "insufficient":
      return "Not enough tacos.";
    case "disabled":
      return "Self-serve shop is currently disabled.";
    case "forbidden":
      return "You can only cancel your own orders.";
    case "not_pending":
      return "That order is no longer pending.";
    case "not_found":
      return "Order not found.";
    case "missing":
      return "Missing form data.";
    case "admin_only":
      return "Admin pages are not for you — but the shop is.";
    default:
      return `Error: ${err}`;
  }
}

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const items = await listActiveItems(db);
  const session = await auth();
  const slackId = (session as { slackUserId?: string } | null)?.slackUserId ?? null;
  const me = slackId
    ? (await db.select().from(users).where(eq(users.id, slackId)))[0]
    : null;
  const flagOn = config.shopSelfServeEnabled;
  const pending = slackId && flagOn
    ? await db
        .select()
        .from(orders)
        .where(and(eq(orders.userId, slackId), eq(orders.status, "pending")))
        .orderBy(desc(orders.createdAt))
    : [];

  const channelLink = flagOn
    ? `https://slack.com/app_redirect?channel=${config.tacoshopChannelId}`
    : null;
  // Legacy HR contact path — shown only when the self-serve flag is off so
  // /shop keeps its pre-feature instructions during the rollout window.
  const hrId = !flagOn ? config.hr.slackId : undefined;
  const hrHandle = !flagOn ? config.hr.slackHandle : undefined;
  const hrLabel = hrHandle ? `@${hrHandle}` : "HR";
  const hrLink = hrId
    ? `https://slack.com/app_redirect?channel=${hrId}`
    : null;

  const errStr = typeof sp.err === "string" ? sp.err : undefined;
  const okStr = typeof sp.ok === "string" ? sp.ok : undefined;
  const cancelledStr =
    typeof sp.cancelled === "string" ? sp.cancelled : undefined;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">🌮 Tacobot Shop</h1>
        <p className="mt-2 text-gray-600">
          Earn tacos by being recognized in <code>#taqueria</code>.{" "}
          {flagOn ? (
            slackId ? (
              <>Click <em>Buy</em> on an item to redeem. </>
            ) : (
              <>
                <Link
                  href="/api/auth/signin?callbackUrl=/shop"
                  className="font-medium text-amber-700 hover:underline"
                >
                  Sign in with Slack
                </Link>{" "}
                to buy items.{" "}
              </>
            )
          ) : null}
          {channelLink ? (
            <>
              Prefer Slack?{" "}
              <a
                href={channelLink}
                className="font-medium text-amber-700 hover:underline"
              >
                Post your order in #tacoshop
              </a>
              .
            </>
          ) : null}
          {!flagOn ? (
            <>
              To redeem an item, DM{" "}
              {hrLink ? (
                <a
                  href={hrLink}
                  className="font-medium text-amber-700 hover:underline"
                >
                  {hrLabel}
                </a>
              ) : (
                hrLabel
              )}{" "}
              with the item name. Check your balance by DMing{" "}
              <code>@tacobot</code> the word <code>balance</code>.
            </>
          ) : null}
        </p>
        {me && flagOn ? (
          <p className="mt-2 text-sm text-gray-600">
            Signed in as <strong>{me.name}</strong> · Balance:{" "}
            <strong>{me.balance} 🌮</strong> ·{" "}
            <Link
              href="/api/auth/signout?callbackUrl=/shop"
              className="underline"
            >
              Sign out
            </Link>
          </p>
        ) : null}
        {errStr ? (
          <p className="mt-2 text-sm text-red-600">{errorMessage(errStr)}</p>
        ) : null}
        {okStr ? (
          <p className="mt-2 text-sm text-green-700">Order placed.</p>
        ) : null}
        {cancelledStr ? (
          <p className="mt-2 text-sm text-amber-700">Order cancelled.</p>
        ) : null}
      </header>

      {flagOn && pending.length > 0 ? (
        <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-lg font-semibold">Your pending orders</h2>
          <ul className="space-y-2">
            {pending.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span>
                  {o.itemNameSnap} · {o.pricePaid} 🌮 ·{" "}
                  {o.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                </span>
                <form action={cancelMyOrder}>
                  <input type="hidden" name="order_id" value={o.id} />
                  <button className="rounded bg-red-100 px-3 py-1 text-red-800 hover:bg-red-200">
                    Cancel
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {items.length === 0 ? (
        <p className="text-gray-500">No items available right now. Check back later.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {items.map((it) => {
            const soldOut = it.quantity !== null && it.quantity <= 0;
            const cantAfford = flagOn && me ? me.balance < it.priceTacos : false;
            const disabled = !flagOn || !slackId || soldOut || cantAfford;
            const label = soldOut
              ? "Sold out"
              : !flagOn
                ? null
                : !slackId
                  ? "Sign in to buy"
                  : cantAfford
                    ? "Not enough 🌮"
                    : `Buy for ${it.priceTacos} 🌮`;
            return (
              <li
                key={it.id}
                className="rounded-lg border border-gray-200 p-4"
              >
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.imageUrl}
                    alt=""
                    className="mb-3 h-40 w-full rounded object-cover"
                  />
                ) : null}
                <div className="flex items-start justify-between gap-4">
                  <h2 className="text-lg font-semibold">{it.name}</h2>
                  <span className="whitespace-nowrap rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
                    {it.priceTacos} 🌮
                  </span>
                </div>
                {it.description ? (
                  <p className="mt-2 text-sm text-gray-600">{it.description}</p>
                ) : null}
                {it.quantity !== null ? (
                  <p className="mt-2 text-xs text-gray-500">
                    {it.quantity} available
                  </p>
                ) : null}
                {label ? (
                  <form action={buyItem} className="mt-3">
                    <input type="hidden" name="item_id" value={it.id} />
                    <button
                      disabled={disabled}
                      className="w-full rounded bg-amber-500 px-3 py-2 text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-gray-300"
                    >
                      {label}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
