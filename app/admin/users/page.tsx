import type { Metadata } from "next";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { items, users } from "@/lib/db/schema";
import { deductTacos } from "./actions";
import { AdjustForm } from "./AdjustForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users & redemption",
};

export default async function UsersPage() {
  const [allUsers, activeItems] = await Promise.all([
    db.select().from(users).where(eq(users.isActive, true)).orderBy(desc(users.balance), asc(users.name)),
    db.select({ id: items.id, name: items.name, priceTacos: items.priceTacos })
      .from(items).where(eq(items.isActive, true)).orderBy(asc(items.priceTacos)),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Users & redemption</h1>
      <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
        <thead className="text-left text-sm text-gray-600">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Received</th>
            <th className="px-4 py-3">Balance</th>
            <th className="px-4 py-3">Today left</th>
            <th className="px-4 py-3">Redeem</th>
            <th className="px-4 py-3">Adjust</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-sm">
          {allUsers.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-3 font-medium">{u.name}</td>
              <td className="px-4 py-3">{u.receivedTotal}</td>
              <td className="px-4 py-3 font-semibold">{u.balance}</td>
              <td className="px-4 py-3 text-gray-500">{u.dailyRemaining}</td>
              <td className="px-4 py-3">
                <form action={deductTacos} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="employee_id" value={u.id} />
                  <select name="item_id" required className="rounded border border-gray-300 px-2 py-1">
                    <option value="" disabled>Pick item</option>
                    {activeItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.priceTacos} 🌮)
                      </option>
                    ))}
                  </select>
                  <input
                    name="amount"
                    type="number"
                    min={1}
                    max={u.balance}
                    placeholder="amount"
                    required
                    className="w-24 rounded border border-gray-300 px-2 py-1"
                  />
                  <input
                    name="reason"
                    placeholder="note (optional)"
                    className="flex-1 rounded border border-gray-300 px-2 py-1"
                  />
                  <button type="submit" className="rounded bg-amber-500 px-3 py-1 text-white hover:bg-amber-600">
                    Deduct
                  </button>
                </form>
              </td>
              <td className="px-4 py-3">
                <AdjustForm userId={u.id} userName={u.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
