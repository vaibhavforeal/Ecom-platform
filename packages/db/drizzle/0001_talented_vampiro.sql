CREATE TABLE "carrier_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"label" text NOT NULL,
	"sealed_credentials" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"pickup_location_ref" text,
	"capability_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "carrier_accounts_code_check" CHECK ("carrier_accounts"."carrier_code" IN ('shiprocket', 'shipmozo', 'nimbuspost', 'ekart', 'delhivery', 'bluedart', 'xpressbees', 'dtdc', 'ecom_express', 'fake'))
);
--> statement-breakpoint
CREATE TABLE "carrier_lane_stats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"from_prefix" text NOT NULL,
	"to_prefix" text NOT NULL,
	"payment_mode" text NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"rto" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"delivery_days_sum" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serviceability_cache" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"from_pincode" text NOT NULL,
	"to_pincode" text NOT NULL,
	"weight_slab_grams" integer NOT NULL,
	"payment_mode" text NOT NULL,
	"quotes" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "carrier_accounts" ADD CONSTRAINT "carrier_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_accounts" ADD CONSTRAINT "carrier_accounts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_lane_stats" ADD CONSTRAINT "carrier_lane_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serviceability_cache" ADD CONSTRAINT "serviceability_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_accounts_tenant_carrier_label_key" ON "carrier_accounts" USING btree ("tenant_id","carrier_code","label");--> statement-breakpoint
CREATE INDEX "carrier_accounts_enabled_idx" ON "carrier_accounts" USING btree ("tenant_id","is_enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_lane_stats_key" ON "carrier_lane_stats" USING btree ("tenant_id","carrier_code","from_prefix","to_prefix","payment_mode","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "serviceability_lane_key" ON "serviceability_cache" USING btree ("tenant_id","carrier_code","from_pincode","to_pincode","weight_slab_grams","payment_mode");--> statement-breakpoint
CREATE INDEX "serviceability_expiry_idx" ON "serviceability_cache" USING btree ("expires_at");