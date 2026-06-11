CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_name_snap" text NOT NULL,
	"description_snap" text,
	"redemption_instructions_snap" text,
	"price_paid" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"redeem_tx_id" uuid,
	"refund_tx_id" uuid,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"fulfilled_by_admin_id" text,
	"cancelled_by_admin_id" text,
	CONSTRAINT "orders_price_positive" CHECK ("orders"."price_paid" > 0),
	CONSTRAINT "orders_state_consistency" CHECK ((
        ("orders"."status" = 'pending'
          AND "orders"."fulfilled_at" IS NULL AND "orders"."cancelled_at" IS NULL
          AND "orders"."fulfilled_by_admin_id" IS NULL AND "orders"."cancelled_by_admin_id" IS NULL
          AND "orders"."refund_tx_id" IS NULL)
        OR
        ("orders"."status" = 'fulfilled'
          AND "orders"."fulfilled_at" IS NOT NULL AND "orders"."fulfilled_by_admin_id" IS NOT NULL
          AND "orders"."cancelled_at" IS NULL AND "orders"."cancelled_by_admin_id" IS NULL
          AND "orders"."refund_tx_id" IS NULL)
        OR
        ("orders"."status" = 'cancelled'
          AND "orders"."cancelled_at" IS NOT NULL AND "orders"."refund_tx_id" IS NOT NULL
          AND "orders"."fulfilled_at" IS NULL AND "orders"."fulfilled_by_admin_id" IS NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_shape_and_rule";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "order_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfilled_by_admin_id_users_id_fk" FOREIGN KEY ("fulfilled_by_admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_admin_id_users_id_fk" FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_created" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_created" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_item_created" ON "orders" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_shape_and_rule" CHECK ((
        ("transactions"."type" = 'give'
          AND "transactions"."from_user_id" IS NOT NULL
          AND "transactions"."admin_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NULL
          AND "transactions"."order_id" IS NULL
          AND "transactions"."from_user_id" <> "transactions"."to_user_id")
        OR
        ("transactions"."type" = 'redeem'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."item_id" IS NOT NULL
          AND "transactions"."reversed_transaction_id" IS NULL
          AND (
            ("transactions"."admin_user_id" IS NOT NULL AND "transactions"."order_id" IS NULL)
            OR ("transactions"."admin_user_id" IS NULL AND "transactions"."order_id" IS NOT NULL)
          ))
        OR
        ("transactions"."type" = 'reversal'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."admin_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NOT NULL
          AND "transactions"."order_id" IS NULL)
        OR
        ("transactions"."type" = 'grant'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NULL
          AND (
            ("transactions"."admin_user_id" IS NOT NULL AND "transactions"."order_id" IS NULL)
            OR ("transactions"."order_id" IS NOT NULL)
          ))
      ));