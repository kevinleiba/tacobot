import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { listOrders } from "@/lib/db/queries";
import type { OrderStatus } from "@/lib/db/schema";
import { fulfillOrderAction, cancelOrderAction } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Orders" };

const STATUSES: OrderStatus[] = ["pending", "fulfilled", "cancelled"];

function isStatus(v: string | undefined): v is OrderStatus {
  return v === "pending" || v === "fulfilled" || v === "cancelled";
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status: OrderStatus = isStatus(sp.status) ? sp.status : "pending";
  const rows = await listOrders(db, { status, limit: 100 });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Orders</h1>
      <nav className="flex gap-3 text-sm">
        {STATUSES.map((s) => (
          <a
            key={s}
            href={`/admin/orders?status=${s}`}
            className={
              s === status
                ? "font-semibold underline"
                : "text-gray-600 hover:underline"
            }
          >
            {s}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No {status} orders.</p>
      ) : (
        <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
          <thead className="text-left text-sm text-gray-600">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Buyer</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-sm">
            {rows.map((o) => (
              <tr key={o.id}>
                <td className="px-4 py-3 text-gray-500">
                  {o.createdAt.toISOString()}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{o.userId}</td>
                <td className="px-4 py-3">{o.itemNameSnap}</td>
                <td className="px-4 py-3">{o.pricePaid} 🌮</td>
                <td className="px-4 py-3">
                  {o.status}
                  {o.status === "fulfilled" && o.fulfilledByAdminId ? (
                    <span className="ml-1 text-xs text-gray-500">
                      by {o.fulfilledByAdminId}
                    </span>
                  ) : null}
                  {o.status === "cancelled" ? (
                    <span className="ml-1 text-xs text-gray-500">
                      by {o.cancelledByAdminId ?? "buyer"}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {o.status === "pending" ? (
                    <div className="flex gap-2">
                      <form action={fulfillOrderAction}>
                        <input type="hidden" name="order_id" value={o.id} />
                        <button className="rounded bg-green-600 px-3 py-1 text-white hover:bg-green-700">
                          Fulfill
                        </button>
                      </form>
                      <form action={cancelOrderAction}>
                        <input type="hidden" name="order_id" value={o.id} />
                        <button className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700">
                          Cancel
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="text-gray-500">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
