CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"image_media_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "categories_parent_not_self_check" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image_media_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text,
	"checksum" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"derivatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_status_check" CHECK ("media"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "media_byte_size_check" CHECK ("media"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_categories_tenant_id_product_id_category_id_pk" PRIMARY KEY("tenant_id","product_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "product_collections" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_collections_tenant_id_product_id_collection_id_pk" PRIMARY KEY("tenant_id","product_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_media_tenant_id_product_id_media_id_pk" PRIMARY KEY("tenant_id","product_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "product_option_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_paise" bigint NOT NULL,
	"compare_at_paise" bigint,
	"cost_paise" bigint,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"weight_grams" integer NOT NULL,
	"dims_mm" jsonb,
	"low_stock_at" integer DEFAULT 2,
	"image_media_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."price_paise" >= 0),
	CONSTRAINT "product_variants_compare_at_check" CHECK ("product_variants"."compare_at_paise" IS NULL OR "product_variants"."compare_at_paise" >= 0),
	CONSTRAINT "product_variants_weight_check" CHECK ("product_variants"."weight_grams" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"product_type" text,
	"vendor" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hsn_code" text,
	"tax_rate_bps" integer,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'C')) STORED,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('draft', 'active', 'archived')),
	CONSTRAINT "products_tax_rate_check" CHECK ("products"."tax_rate_bps" IS NULL OR ("products"."tax_rate_bps" >= 0 AND "products"."tax_rate_bps" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "url_slugs" (
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "url_slugs_tenant_id_slug_pk" PRIMARY KEY("tenant_id","slug"),
	CONSTRAINT "url_slugs_entity_type_check" CHECK ("url_slugs"."entity_type" IN ('product', 'category', 'collection'))
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_image_media_id_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_image_media_id_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_option_id_product_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."product_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_image_media_id_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_slugs" ADD CONSTRAINT "url_slugs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_tenant_parent_idx" ON "categories" USING btree ("tenant_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "collections_tenant_visible_idx" ON "collections" USING btree ("tenant_id","is_visible","position");--> statement-breakpoint
CREATE UNIQUE INDEX "media_tenant_storage_key_key" ON "media" USING btree ("tenant_id","storage_key");--> statement-breakpoint
CREATE INDEX "media_tenant_checksum_idx" ON "media" USING btree ("tenant_id","checksum");--> statement-breakpoint
CREATE INDEX "media_status_idx" ON "media" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_categories_category_idx" ON "product_categories" USING btree ("tenant_id","category_id","position");--> statement-breakpoint
CREATE INDEX "product_collections_collection_idx" ON "product_collections" USING btree ("tenant_id","collection_id","position");--> statement-breakpoint
CREATE INDEX "product_media_product_idx" ON "product_media" USING btree ("tenant_id","product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_option_values_key" ON "product_option_values" USING btree ("tenant_id","option_id","value");--> statement-breakpoint
CREATE INDEX "product_option_values_option_idx" ON "product_option_values" USING btree ("tenant_id","option_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_options_product_name_key" ON "product_options" USING btree ("tenant_id","product_id","name");--> statement-breakpoint
CREATE INDEX "product_options_product_idx" ON "product_options" USING btree ("tenant_id","product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_key" ON "product_variants" USING btree ("tenant_id","sku") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_option_combo_key" ON "product_variants" USING btree ("tenant_id","product_id","options") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("tenant_id","product_id","position");--> statement-breakpoint
CREATE INDEX "product_variants_barcode_idx" ON "product_variants" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status","published_at");--> statement-breakpoint
CREATE INDEX "products_tenant_updated_idx" ON "products" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "products_tags_idx" ON "products" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "url_slugs_one_canonical_key" ON "url_slugs" USING btree ("tenant_id","entity_type","entity_id") WHERE is_canonical;--> statement-breakpoint
CREATE INDEX "url_slugs_entity_idx" ON "url_slugs" USING btree ("tenant_id","entity_type","entity_id");