CREATE TABLE "cart_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_lines_quantity_check" CHECK ("cart_lines"."quantity" > 0 AND "cart_lines"."quantity" <= 100)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"buyer_name" text,
	"buyer_phone_e164" text,
	"buyer_email" text,
	"shipping_address" jsonb,
	"coupon_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_status_check" CHECK ("carts"."status" IN ('active', 'converted'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"email" text,
	"name" text,
	"first_order_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_phone_e164_check" CHECK ("customers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"next_number" bigint DEFAULT 1001 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_actor_type_check" CHECK ("order_events"."actor_type" IN ('staff', 'customer', 'system', 'support_impersonation'))
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text DEFAULT 'item' NOT NULL,
	"variant_id" uuid,
	"title_snapshot" text NOT NULL,
	"sku_snapshot" text DEFAULT '' NOT NULL,
	"hsn_snapshot" text,
	"quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_lines_kind_check" CHECK ("order_lines"."kind" IN ('item', 'shipping')),
	CONSTRAINT "order_lines_quantity_check" CHECK ("order_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_number" bigint NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"payment_status" text DEFAULT 'pending' NOT NULL,
	"fulfilment_status" text DEFAULT 'unfulfilled' NOT NULL,
	"cart_id" uuid,
	"customer_id" uuid,
	"idempotency_key" text,
	"checkout_fingerprint" text,
	"buyer_name" text NOT NULL,
	"buyer_phone_e164" text NOT NULL,
	"buyer_email" text,
	"shipping_address" jsonb NOT NULL,
	"place_of_supply" text NOT NULL,
	"buyer_gstin" text,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"payment_mode" text NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"shipping_paise" bigint DEFAULT 0 NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"amount_paid_paise" bigint DEFAULT 0 NOT NULL,
	"cod_due_paise" bigint DEFAULT 0 NOT NULL,
	"awb_cod_synced_at" timestamp with time zone,
	"promotion_id" uuid,
	"coupon_code_snapshot" text,
	"payment_provider" text,
	"gateway_order_ref" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('pending_payment', 'confirmed', 'processing', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'rto_initiated', 'rto_delivered', 'return_requested', 'return_picked', 'refunded', 'cancelled', 'abandoned')),
	CONSTRAINT "orders_payment_status_check" CHECK ("orders"."payment_status" IN ('pending', 'partially_paid', 'paid', 'refund_initiated', 'refunded')),
	CONSTRAINT "orders_fulfilment_status_check" CHECK ("orders"."fulfilment_status" IN ('unfulfilled', 'partially_shipped', 'shipped', 'delivered', 'rto')),
	CONSTRAINT "orders_channel_check" CHECK ("orders"."channel" IN ('web', 'pos', 'whatsapp', 'manual')),
	CONSTRAINT "orders_payment_mode_check" CHECK ("orders"."payment_mode" IN ('prepaid', 'cod', 'cod_advance')),
	CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" IN ('razorpay', 'mock')),
	CONSTRAINT "orders_total_check" CHECK ("orders"."total_paise" = "orders"."subtotal_paise" - "orders"."discount_paise" + "orders"."shipping_paise"),
	CONSTRAINT "orders_amount_paid_check" CHECK ("orders"."amount_paid_paise" >= 0),
	CONSTRAINT "orders_cod_due_check" CHECK ("orders"."cod_due_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_series" (
	"tenant_id" uuid NOT NULL,
	"series_code" text NOT NULL,
	"financial_year" text NOT NULL,
	"prefix" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_series_tenant_id_series_code_financial_year_pk" PRIMARY KEY("tenant_id","series_code","financial_year")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"series_code" text NOT NULL,
	"financial_year" text NOT NULL,
	"number" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"place_of_supply" text NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"irn" text,
	"irn_qr" text,
	"irn_registered_at" timestamp with time zone,
	CONSTRAINT "invoices_doc_type_check" CHECK ("invoices"."doc_type" IN ('tax_invoice', 'bill_of_supply'))
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"label" text DEFAULT 'Default' NOT NULL,
	"public_key_id" text NOT NULL,
	"sealed_credentials" text NOT NULL,
	"sealed_webhook_secret" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "payment_accounts_provider_check" CHECK ("payment_accounts"."provider_code" IN ('razorpay', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"gateway_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"order_id" uuid,
	"payment_id" uuid,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pwe_provider_check" CHECK ("payment_webhook_events"."provider_code" IN ('razorpay', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"method" text,
	"fee_paise" bigint,
	"fee_tax_paise" bigint,
	"error_code" text,
	"error_description" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_check" CHECK ("payments"."provider_code" IN ('razorpay', 'mock')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('created', 'authorized', 'captured', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"gateway_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_paise" > 0),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" IN ('pending', 'processing', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"slot" integer NOT NULL,
	"customer_slot" integer DEFAULT 0 NOT NULL,
	"discount_paise" bigint NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_limit_total" integer,
	"usage_limit_per_customer" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "promotions_status_check" CHECK ("promotions"."status" IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason_check";--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_lines_cart_variant_key" ON "cart_lines" USING btree ("tenant_id","cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "carts_tenant_updated_idx" ON "carts" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_phone_key" ON "customers" USING btree ("tenant_id","phone_e164");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number_key" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idem_key" ON "orders" USING btree ("tenant_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_cart_pending_key" ON "orders" USING btree ("tenant_id","cart_id") WHERE cart_id IS NOT NULL AND status = 'pending_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_gateway_ref_key" ON "orders" USING btree ("tenant_id","gateway_order_ref") WHERE gateway_order_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status","placed_at");--> statement-breakpoint
CREATE INDEX "orders_expiry_idx" ON "orders" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_series_number_key" ON "invoices" USING btree ("tenant_id","series_code","financial_year","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_doc_key" ON "invoices" USING btree ("tenant_id","order_id","doc_type");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_tenant_provider_label_key" ON "payment_accounts" USING btree ("tenant_id","provider_code","label");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_one_enabled_key" ON "payment_accounts" USING btree ("tenant_id") WHERE is_enabled;--> statement-breakpoint
CREATE UNIQUE INDEX "pwe_gateway_event_key" ON "payment_webhook_events" USING btree ("tenant_id","provider_code","gateway_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_payment_key" ON "payments" USING btree ("tenant_id","gateway_payment_id") WHERE gateway_payment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_payment_key" ON "refunds" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cr_promo_slot_key" ON "coupon_redemptions" USING btree ("tenant_id","promotion_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "cr_promo_customer_slot_key" ON "coupon_redemptions" USING btree ("tenant_id","promotion_id","customer_id","customer_slot") WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cr_promo_order_key" ON "coupon_redemptions" USING btree ("tenant_id","promotion_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_tenant_code_key" ON "promotions" USING btree ("tenant_id","code");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK ("stock_movements"."reason" IN ('opening_balance', 'adjustment', 'sale', 'cancellation_restock'));