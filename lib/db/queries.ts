import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { items, orders, transactions, users } from "./schema";
import type { DbLike } from "./types";
import type { OrderStatus } from "./schema";

/**
 * Insert or update a user. On conflict, updates the name and updatedAt
 * timestamp and reactivates the row (`is_active=true`) while preserving all
 * counters (receivedTotal, balance, dailyRemaining).
 *
 * Reactivation is correct because every caller already vets liveness before
 * invoking: `sync-users` and the `team_join`/`user_change` handlers skip
 * deleted users explicitly, and the lazy paths in message/reaction handlers
 * only fire when a real user is actively giving or receiving. Without this,
 * once a row flips to `is_active=false` (sync sweep, Slack `deleted=true`
 * payload), no path ever restores it — the user becomes permanently invisible
 * to the admin page.
 */
export async function upsertUser(
  db: DbLike,
  input: { id: string; name: string; dailyAllowance: number },
) {
  await db
    .insert(users)
    .values({
      id: input.id,
      name: input.name,
      dailyRemaining: input.dailyAllowance,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        name: input.name,
        isActive: true,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Ensure a user row exists for `id`. On insert, name defaults to the id as a
 * placeholder; on conflict, leaves name and counters untouched. Use this from
 * lazy paths (message/reaction handlers) that only have a Slack ID, so a real
 * name resolved later is never clobbered.
 */
export async function ensureUserExists(
  db: DbLike,
  input: { id: string; dailyAllowance: number },
) {
  await db
    .insert(users)
    .values({
      id: input.id,
      name: input.id,
      dailyRemaining: input.dailyAllowance,
    })
    .onConflictDoNothing({ target: users.id });
}

export type ListOrdersOptions = {
  status?: OrderStatus;
  userId?: string;
  itemId?: string;
  cursor?: { createdAt: Date };
  limit?: number;
};

/**
 * List orders newest-first with optional filters and cursor pagination.
 * `cursor.createdAt` is exclusive — pass the createdAt of the last row of the
 * previous page to fetch older rows. Returns up to `limit` rows.
 */
export async function listOrders(db: DbLike, opts: ListOrdersOptions = {}) {
  const limit = opts.limit ?? 50;
  const conds = [];
  if (opts.status) conds.push(eq(orders.status, opts.status));
  if (opts.userId) conds.push(eq(orders.userId, opts.userId));
  if (opts.itemId) conds.push(eq(orders.itemId, opts.itemId));
  if (opts.cursor) conds.push(lt(orders.createdAt, opts.cursor.createdAt));
  const q = db.select().from(orders);
  const filtered = conds.length ? q.where(and(...conds)) : q;
  return filtered.orderBy(desc(orders.createdAt)).limit(limit);
}

export async function getOrderById(db: DbLike, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row ?? null;
}

/**
 * List active shop items, cheapest first then alphabetical. Returns only the
 * fields needed for display on `/shop`.
 */
export async function listActiveItems(db: DbLike) {
  return db
    .select({
      id: items.id,
      name: items.name,
      description: items.description,
      imageUrl: items.imageUrl,
      priceTacos: items.priceTacos,
      quantity: items.quantity,
    })
    .from(items)
    .where(eq(items.isActive, true))
    .orderBy(asc(items.priceTacos), asc(items.name));
}

export type GiveGroupKey = {
  fromUserId: string;
  slackChannelId: string;
  slackMessageTs: string;
};

/**
 * For each `(fromUserId, channel, message_ts)` give-group passed in, count
 * how many of its underlying `type='give'` rows have a matching `type='reversal'`
 * row referencing them via `reversed_transaction_id`. Returns a map keyed by
 * `${fromUserId}|${channel}|${messageTs}`. Used by the admin activity page to
 * decide whether to render a "↺ reversed" badge.
 *
 * Counting per-giver matters: a single Slack message can produce multiple
 * give-groups at the same `(channel, ts)` — e.g. the author's text-mention
 * give plus reactor-gives — and those groups can be reversed independently
 * (reactor unreacts but author's message stays).
 */
export async function countReversalsPerGiveGroup(
  db: DbLike,
  groups: GiveGroupKey[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (groups.length === 0) return out;

  const giveTbl = alias(transactions, "g");
  const reversalTbl = alias(transactions, "r");

  const rows = await db
    .select({
      fromUserId: giveTbl.fromUserId,
      slackChannelId: giveTbl.slackChannelId,
      slackMessageTs: giveTbl.slackMessageTs,
      count: sql<number>`count(${reversalTbl.id})::int`,
    })
    .from(giveTbl)
    .leftJoin(
      reversalTbl,
      and(
        eq(reversalTbl.reversedTransactionId, giveTbl.id),
        eq(reversalTbl.type, "reversal"),
      ),
    )
    .where(
      and(
        eq(giveTbl.type, "give"),
        or(
          ...groups.map((g) =>
            and(
              eq(giveTbl.fromUserId, g.fromUserId),
              eq(giveTbl.slackChannelId, g.slackChannelId),
              eq(giveTbl.slackMessageTs, g.slackMessageTs),
            ),
          ),
        ),
      ),
    )
    .groupBy(giveTbl.fromUserId, giveTbl.slackChannelId, giveTbl.slackMessageTs);

  for (const r of rows) {
    out.set(`${r.fromUserId}|${r.slackChannelId}|${r.slackMessageTs}`, r.count);
  }
  return out;
}

export type LeaderboardMetric = "received" | "given" | "combined" | "redeemable";

export type LeaderboardRow = {
  userId: string;
  total: number;
};

export type LeaderboardOptions = {
  metric: LeaderboardMetric;
  since: Date | null;
  channel: string | null;
};

/**
 * Active users ranked by net tacos for the chosen metric/period/channel.
 *
 * `received` (all-time, no channel filter) reads `users.received_total`
 * directly — that's the canonical lifetime counter and stays consistent with
 * the admin/users page across operational events that mutate the audit log
 * (notably `purge-channel-history`, which hard-deletes give rows without
 * touching cached counters).
 *
 * `received` with a `since` or `channel` filter aggregates from
 * `transactions`: sum of gives received − sum of reversals of those gives
 * + sum of admin grants to user (signed; the `zero-balances` reset is a
 * negative grant). Grants are excluded when a channel filter is set, since
 * grant rows have no `slack_channel_id`. The `since` filter applies to
 * `created_at` for both gives and grants (net-by-give-date semantics for
 * reversals: if the original give is in the window, its later reversal
 * counts). These transaction-replay analytics may diverge from
 * `users.received_total` after a `purge-channel-history` run.
 *
 * `given` net = sum of gives sent − sum of reversals of those gives. Admin
 *               grants set `admin_user_id`, not `from_user_id`, so they
 *               never count as peer-given.
 *
 * `combined` = `received` + `given` per user.
 *
 * `redeemable` is a current-state metric — it reads `users.balance` directly
 * and ignores the period/channel filters, since balance reflects all-time
 * receipts net of reversals and redemptions and isn't channel-scoped.
 */
export async function getLeaderboard(
  db: DbLike,
  opts: LeaderboardOptions,
): Promise<LeaderboardRow[]> {
  if (opts.metric === "redeemable") {
    return runRedeemable(db);
  }
  if (opts.metric !== "combined") {
    return runDirectional(db, opts.metric, opts);
  }
  const [recv, giv] = await Promise.all([
    runDirectional(db, "received", opts),
    runDirectional(db, "given", opts),
  ]);
  const totals = new Map<string, number>();
  for (const r of recv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  for (const r of giv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
}

async function runRedeemable(db: DbLike): Promise<LeaderboardRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      total: users.balance,
    })
    .from(users)
    .where(and(eq(users.isActive, true), sql`${users.balance} > 0`))
    .orderBy(desc(users.balance), asc(users.id));
  return rows.map((r) => ({ userId: r.userId, total: r.total }));
}

async function runDirectional(
  db: DbLike,
  direction: "received" | "given",
  opts: { since: Date | null; channel: string | null },
): Promise<LeaderboardRow[]> {
  // For the all-time, all-channel `received` view, read `users.received_total`
  // directly: that's the canonical lifetime counter and stays correct across
  // operational events that mutate the audit log (notably
  // `purge-channel-history`, which hard-deletes give rows without touching
  // cached counters). Filtered views (period/channel) must aggregate from
  // `transactions` because the cached counter has no per-period/per-channel
  // breakdown — they're transaction-replay analytics and accept the risk that
  // history mutations skew them.
  if (direction === "received" && opts.since === null && opts.channel === null) {
    return runReceivedAllTime(db);
  }

  const giveTotals = await sumGivesNetReversals(db, direction, opts);

  // Admin grants only affect the receiving side: they move `users.received_total`
  // (and `balance`) by the signed amount but never set `from_user_id`. So they
  // count toward `received` but not `given`. Channel filter excludes grants
  // entirely because grant rows have no `slack_channel_id`.
  const grantTotals =
    direction === "received" && !opts.channel ? await sumGrantsToUser(db, opts.since) : new Map();

  const totals = new Map<string, number>();
  for (const [userId, total] of giveTotals) totals.set(userId, total);
  for (const [userId, total] of grantTotals)
    totals.set(userId, (totals.get(userId) ?? 0) + total);

  const candidateIds = [...totals.keys()];
  if (candidateIds.length === 0) return [];

  const activeRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidateIds), eq(users.isActive, true)));
  const activeIds = new Set(activeRows.map((r) => r.id));

  return [...totals.entries()]
    .filter(([userId, total]) => activeIds.has(userId) && total > 0)
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
}

async function runReceivedAllTime(db: DbLike): Promise<LeaderboardRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      total: users.receivedTotal,
    })
    .from(users)
    .where(and(eq(users.isActive, true), sql`${users.receivedTotal} > 0`))
    .orderBy(desc(users.receivedTotal), asc(users.id));
  return rows.map((r) => ({ userId: r.userId, total: r.total }));
}

async function sumGivesNetReversals(
  db: DbLike,
  direction: "received" | "given",
  opts: { since: Date | null; channel: string | null },
): Promise<Map<string, number>> {
  const g = alias(transactions, direction === "received" ? "g_recv" : "g_giv");
  const r = alias(transactions, direction === "received" ? "r_recv" : "r_giv");
  const userIdCol = direction === "received" ? g.toUserId : g.fromUserId;

  const whereClauses = [
    eq(g.type, "give"),
    ...(opts.since ? [gte(g.createdAt, opts.since)] : []),
    ...(opts.channel ? [eq(g.slackChannelId, opts.channel)] : []),
  ];

  const rows = await db
    .select({
      userId: sql<string>`${userIdCol}`.as("user_id"),
      total: sql<number>`(coalesce(sum(${g.amount}), 0) - coalesce(sum(${r.amount}), 0))::int`.as(
        "total",
      ),
    })
    .from(g)
    .leftJoin(r, and(eq(r.reversedTransactionId, g.id), eq(r.type, "reversal")))
    .where(and(...whereClauses))
    .groupBy(userIdCol);

  const out = new Map<string, number>();
  for (const row of rows) out.set(row.userId, row.total);
  return out;
}

async function sumGrantsToUser(
  db: DbLike,
  since: Date | null,
): Promise<Map<string, number>> {
  const whereClauses = [
    eq(transactions.type, "grant"),
    ...(since ? [gte(transactions.createdAt, since)] : []),
  ];
  const rows = await db
    .select({
      userId: sql<string>`${transactions.toUserId}`.as("user_id"),
      total: sql<number>`coalesce(sum(${transactions.amount}), 0)::int`.as("total"),
    })
    .from(transactions)
    .where(and(...whereClauses))
    .groupBy(transactions.toUserId);

  const out = new Map<string, number>();
  for (const row of rows) out.set(row.userId, row.total);
  return out;
}
