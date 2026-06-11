import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),                                  // Slack user ID, "U..."
    name: text("name").notNull(),
    dailyRemaining: integer("daily_remaining").notNull(),
    receivedTotal: integer("received_total").notNull().default(0),
    balance: integer("balance").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dailyNonNegative: check("users_daily_remaining_nonneg", sql`${t.dailyRemaining} >= 0`),
    // `received_total` and `balance` may go negative after a reversal of a give
    // whose recipient already redeemed: the give that funded the redemption is
    // undone, but the redemption itself stays. The relationship `balance <=
    // received_total` is preserved because reversals decrement both by the
    // same amount.
    balanceLeReceived: check(
      "users_balance_le_received",
      sql`${t.balance} <= ${t.receivedTotal}`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    priceTacos: integer("price_tacos").notNull(),
    quantity: integer("quantity"),
    redemptionInstructions: text("redemption_instructions"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pricePositive: check("items_price_positive", sql`${t.priceTacos} > 0`),
    // `quantity` can be NULL (unlimited stock) or >= 0. Zero means "sold out
    // but still active" — the row stays so a cancel can restore stock.
    quantityNonNegative: check(
      "items_quantity_nonneg",
      sql`${t.quantity} IS NULL OR ${t.quantity} >= 0`,
    ),
    activeNameUnique: uniqueIndex("items_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.isActive}`),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;

export const transactionType = ["give", "redeem", "reversal", "grant"] as const;
export type TransactionType = (typeof transactionType)[number];

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: transactionType }).notNull(),
    toUserId: text("to_user_id").notNull().references(() => users.id),
    fromUserId: text("from_user_id").references(() => users.id),
    adminUserId: text("admin_user_id").references(() => users.id),
    itemId: uuid("item_id").references(() => items.id),
    amount: integer("amount").notNull(),
    reason: text("reason"),
    slackEventId: text("slack_event_id").unique(),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    // For type='reversal' rows only: the give being reversed. UNIQUE so any
    // single give can only be compensated once, even under retries.
    reversedTransactionId: uuid("reversed_transaction_id").unique(),
    // For type='redeem' (self-serve) and type='grant' (refund) rows: the
    // related order. No FK constraint to keep the migration ordering simple;
    // application code is responsible for the relation.
    orderId: uuid("order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // `grant` is the only type that may carry a negative `amount` — admin
    // adjustments need to clawback during onboarding/normalization. The other
    // three types keep their `> 0` invariant.
    amountValid: check(
      "transactions_amount_valid",
      sql`(
        (${t.type} IN ('give','redeem','reversal') AND ${t.amount} > 0)
        OR
        (${t.type} = 'grant' AND ${t.amount} <> 0)
      )`,
    ),
    shapeAndRule: check(
      "transactions_shape_and_rule",
      sql`(
        (${t.type} = 'give'
          AND ${t.fromUserId} IS NOT NULL
          AND ${t.adminUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.reversedTransactionId} IS NULL
          AND ${t.orderId} IS NULL
          AND ${t.fromUserId} <> ${t.toUserId})
        OR
        (${t.type} = 'redeem'
          AND ${t.fromUserId} IS NULL
          AND ${t.itemId} IS NOT NULL
          AND ${t.reversedTransactionId} IS NULL
          AND (
            (${t.adminUserId} IS NOT NULL AND ${t.orderId} IS NULL)
            OR (${t.adminUserId} IS NULL AND ${t.orderId} IS NOT NULL)
          ))
        OR
        (${t.type} = 'reversal'
          AND ${t.fromUserId} IS NULL
          AND ${t.adminUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.reversedTransactionId} IS NOT NULL
          AND ${t.orderId} IS NULL)
        OR
        (${t.type} = 'grant'
          AND ${t.fromUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.reversedTransactionId} IS NULL
          AND (
            (${t.adminUserId} IS NOT NULL AND ${t.orderId} IS NULL)
            OR (${t.orderId} IS NOT NULL)
          ))
      )`,
    ),
    toCreatedIdx: index("transactions_to_created").on(t.toUserId, t.createdAt),
    fromCreatedIdx: index("transactions_from_created").on(t.fromUserId, t.createdAt),
    typeCreatedIdx: index("transactions_type_created").on(t.type, t.createdAt),
    adminCreatedIdx: index("transactions_admin_created").on(t.adminUserId, t.createdAt),
    channelMsgIdx: index("transactions_channel_message").on(
      t.slackChannelId,
      t.slackMessageTs,
    ),
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

export const orderStatus = ["pending", "fulfilled", "cancelled"] as const;
export type OrderStatus = (typeof orderStatus)[number];

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id),
    itemId: uuid("item_id").notNull().references(() => items.id),
    itemNameSnap: text("item_name_snap").notNull(),
    descriptionSnap: text("description_snap"),
    redemptionInstructionsSnap: text("redemption_instructions_snap"),
    pricePaid: integer("price_paid").notNull(),
    status: text("status", { enum: orderStatus }).notNull().default("pending"),
    redeemTxId: uuid("redeem_tx_id"),
    refundTxId: uuid("refund_tx_id"),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    fulfilledByAdminId: text("fulfilled_by_admin_id").references(() => users.id),
    cancelledByAdminId: text("cancelled_by_admin_id").references(() => users.id),
  },
  (t) => ({
    pricePositive: check("orders_price_positive", sql`${t.pricePaid} > 0`),
    // `cancelledByAdminId` may be NULL on buyer self-cancel.
    stateConsistency: check(
      "orders_state_consistency",
      sql`(
        (${t.status} = 'pending'
          AND ${t.fulfilledAt} IS NULL AND ${t.cancelledAt} IS NULL
          AND ${t.fulfilledByAdminId} IS NULL AND ${t.cancelledByAdminId} IS NULL
          AND ${t.refundTxId} IS NULL)
        OR
        (${t.status} = 'fulfilled'
          AND ${t.fulfilledAt} IS NOT NULL AND ${t.fulfilledByAdminId} IS NOT NULL
          AND ${t.cancelledAt} IS NULL AND ${t.cancelledByAdminId} IS NULL
          AND ${t.refundTxId} IS NULL)
        OR
        (${t.status} = 'cancelled'
          AND ${t.cancelledAt} IS NOT NULL AND ${t.refundTxId} IS NOT NULL
          AND ${t.fulfilledAt} IS NULL AND ${t.fulfilledByAdminId} IS NULL)
      )`,
    ),
    statusCreatedIdx: index("orders_status_created").on(t.status, t.createdAt),
    userCreatedIdx: index("orders_user_created").on(t.userId, t.createdAt),
    itemCreatedIdx: index("orders_item_created").on(t.itemId, t.createdAt),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
