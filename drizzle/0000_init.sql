CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."body_type" AS ENUM('hatchback', 'sedan', 'suv', 'mpv', 'coupe', 'pickup', 'motorcycle', 'scooter', 'three_wheeler_passenger', 'three_wheeler_cargo', 'mini_truck', 'lcv', 'mcv', 'hcv', 'tipper', 'tractor_trailer', 'bus', 'tempo_traveller');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."drivetrain" AS ENUM('fwd', 'rwd', 'awd', '4wd');--> statement-breakpoint
CREATE TYPE "public"."e20_verdict" AS ENUM('e20_compliant', 'e20_tolerant', 'e10_only', 'not_applicable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."emission_norm" AS ENUM('bs3', 'bs4', 'bs6_phase1', 'bs6_phase2', 'zero_emission');--> statement-breakpoint
CREATE TYPE "public"."fuel_type" AS ENUM('petrol', 'diesel', 'cng', 'lpg', 'electric', 'hybrid_mild', 'hybrid_strong', 'plugin_hybrid', 'hydrogen', 'flex_fuel');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('active', 'discontinued', 'upcoming');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('none', 'low', 'moderate', 'high');--> statement-breakpoint
CREATE TYPE "public"."source_tier" AS ENUM('oem', 'government', 'industry_body', 'licensed_aggregator', 'editorial', 'community', 'internal_estimate');--> statement-breakpoint
CREATE TYPE "public"."station_type" AS ENUM('petrol', 'diesel', 'cng', 'ev_ac', 'ev_dc', 'hydrogen');--> statement-breakpoint
CREATE TYPE "public"."transmission_type" AS ENUM('manual', 'amt', 'cvt', 'dct', 'torque_converter', 'single_speed', 'imt');--> statement-breakpoint
CREATE TYPE "public"."vehicle_category" AS ENUM('passenger', 'commercial');--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"state_code" text NOT NULL,
	"population" integer,
	"tier" integer,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6)
);
--> statement-breakpoint
CREATE TABLE "states" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_union_territory" boolean DEFAULT false NOT NULL,
	"region" text
);
--> statement-breakpoint
CREATE TABLE "data_quality" (
	"entity_table" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stale_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_table" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_url" text,
	"excerpt" text,
	"confidence" "confidence_level" DEFAULT 'medium' NOT NULL,
	"verified_at" date NOT NULL,
	"superseded_at" timestamp with time zone,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tier" "source_tier" NOT NULL,
	"homepage_url" text,
	"crawl_allowed" boolean DEFAULT false NOT NULL,
	"crawl_notes" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"service_centre_count" integer,
	"service_centre_count_as_of" timestamp with time zone,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"state_code" text NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "vehicle_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"manufacturer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "vehicle_category" NOT NULL,
	"body_type" "body_type" NOT NULL,
	"segment" text NOT NULL,
	"status" "lifecycle_status" DEFAULT 'active' NOT NULL,
	"launch_year" smallint,
	"discontinued_year" smallint,
	"generation" text,
	"summary" text,
	"known_advantages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"known_disadvantages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"common_problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trim_level" text,
	"status" "lifecycle_status" DEFAULT 'active' NOT NULL,
	"fuel_type" "fuel_type" NOT NULL,
	"transmission" "transmission_type" NOT NULL,
	"drivetrain" "drivetrain",
	"emission_norm" "emission_norm" NOT NULL,
	"engine_cc" integer,
	"power_bhp" numeric(6, 2),
	"torque_nm" numeric(6, 2),
	"cylinders" smallint,
	"turbocharged" boolean,
	"battery_kwh" numeric(6, 2),
	"battery_chemistry" text,
	"claimed_range_km" integer,
	"real_world_range_km" integer,
	"dc_charge_kw" numeric(6, 2),
	"ac_charge_kw" numeric(6, 2),
	"dc_charge_minutes10_to80" smallint,
	"battery_warranty_years" smallint,
	"battery_warranty_km" integer,
	"claimed_efficiency" numeric(6, 2),
	"real_world_efficiency_city" numeric(6, 2),
	"real_world_efficiency_highway" numeric(6, 2),
	"efficiency_unit" text,
	"fuel_tank_litres" numeric(6, 2),
	"cng_tank_kg" numeric(6, 2),
	"seating_capacity" smallint,
	"boot_litres" integer,
	"payload_kg" integer,
	"gvw_kg" integer,
	"deck_length_mm" integer,
	"ground_clearance_mm" smallint,
	"kerb_weight_kg" integer,
	"ex_showroom_paise" bigint,
	"scheduled_service_cost5y_paise" bigint,
	"e20_verdict" "e20_verdict" DEFAULT 'unknown' NOT NULL,
	"data_quality_score" smallint,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battery_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chemistry" text NOT NULL,
	"price_paise_per_kwh" bigint NOT NULL,
	"annual_degradation_pct" numeric(4, 2) NOT NULL,
	"replacement_threshold_pct" numeric(4, 2) DEFAULT '70' NOT NULL,
	"as_of" date NOT NULL,
	"source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "economics_refresh_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rows_affected" integer DEFAULT 0 NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "electricity_tariffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"tariff_kind" text NOT NULL,
	"slab_min_units" integer,
	"slab_max_units" integer,
	"price_paise_per_kwh" bigint NOT NULL,
	"as_of" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emission_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fuel_type" "fuel_type" NOT NULL,
	"grams_co2e_per_unit" numeric(10, 2) NOT NULL,
	"unit" text NOT NULL,
	"scope" text DEFAULT 'well_to_wheel' NOT NULL,
	"state_code" text,
	"as_of" date NOT NULL,
	"source_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "finance_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "vehicle_category" NOT NULL,
	"fuel_type" "fuel_type",
	"lender_kind" text DEFAULT 'bank' NOT NULL,
	"annual_rate_pct" numeric(5, 2) NOT NULL,
	"typical_tenure_months" smallint NOT NULL,
	"typical_down_payment_pct" numeric(5, 2) NOT NULL,
	"processing_fee_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"as_of" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"city_id" uuid,
	"fuel_type" "fuel_type" NOT NULL,
	"price_paise" bigint NOT NULL,
	"unit" text DEFAULT 'litre' NOT NULL,
	"as_of" date NOT NULL,
	"source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "maintenance_curves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment" text NOT NULL,
	"fuel_type" "fuel_type" NOT NULL,
	"category" "vehicle_category" DEFAULT 'passenger' NOT NULL,
	"ownership_year" smallint NOT NULL,
	"cost_paise" bigint NOT NULL,
	"reference_annual_km" integer DEFAULT 12000 NOT NULL,
	"marginal_cost_paise_per_km" bigint DEFAULT 0 NOT NULL,
	"source_id" uuid,
	"as_of" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resale_curves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment" text NOT NULL,
	"fuel_type" "fuel_type" NOT NULL,
	"category" "vehicle_category" DEFAULT 'passenger' NOT NULL,
	"age_years" smallint NOT NULL,
	"residual_pct" numeric(5, 2) NOT NULL,
	"liquidity_score" smallint,
	"source_id" uuid,
	"as_of" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_on_road_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"fuel_type" "fuel_type",
	"category" "vehicle_category" DEFAULT 'passenger' NOT NULL,
	"price_band_min_paise" bigint DEFAULT 0 NOT NULL,
	"price_band_max_paise" bigint,
	"road_tax_pct" numeric(5, 2) NOT NULL,
	"registration_fee_paise" bigint DEFAULT 0 NOT NULL,
	"insurance_pct" numeric(5, 2) NOT NULL,
	"other_levy_paise" bigint DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "e20_compatibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid,
	"variant_id" uuid,
	"applies_from" date,
	"applies_to" date,
	"verdict" "e20_verdict" NOT NULL,
	"material_risk_level" "risk_level" DEFAULT 'none' NOT NULL,
	"mileage_delta_min_pct" numeric(4, 2),
	"mileage_delta_max_pct" numeric(4, 2),
	"oem_statement_url" text,
	"oem_statement_summary" text,
	"source_id" uuid,
	"confidence" "confidence_level" DEFAULT 'medium' NOT NULL,
	"inferred_from_norm" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e20_guidance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"applies_to_verdict" "e20_verdict" NOT NULL,
	"min_risk_level" "risk_level" DEFAULT 'none' NOT NULL,
	"applies_to_body_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applies_to_max_year" smallint,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"priority" smallint DEFAULT 50 NOT NULL,
	"source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "e20_kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_slug" text NOT NULL,
	"chunk_index" smallint NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"embedded_at" timestamp with time zone,
	"source_id" uuid,
	"source_url" text,
	"credibility" smallint DEFAULT 50 NOT NULL,
	"published_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"type" "station_type" NOT NULL,
	"name" text,
	"operator" text,
	"state_code" text,
	"city_id" uuid,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"connector_types" text[],
	"max_kw" numeric(6, 2),
	"charger_count" smallint,
	"source_id" uuid,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infra_density" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid,
	"state_code" text,
	"type" "station_type" NOT NULL,
	"station_count" integer DEFAULT 0 NOT NULL,
	"per_lakh_population" numeric(8, 3),
	"percentile" smallint,
	"confidence_score" smallint DEFAULT 50 NOT NULL,
	"median_distance_km" numeric(6, 2),
	"as_of" date NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e20_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"anonymous_id" text,
	"variant_id" uuid,
	"manufacture_year" smallint,
	"odometer_km" integer,
	"result" jsonb NOT NULL,
	"narrative" text,
	"narrative_fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"run_id" uuid,
	"rating" smallint,
	"comment" text,
	"disputed_variant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"run_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"guard_rejected" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"anonymous_id" text,
	"profile" jsonb NOT NULL,
	"profile_bucket" text,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb,
	"narrative" text,
	"narrative_fallback" boolean DEFAULT false NOT NULL,
	"engine_version" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"anonymous_id" text,
	"kind" text NOT NULL,
	"run_id" uuid,
	"share_token" text NOT NULL,
	"blob_url" text,
	"size_bytes" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text,
	"default_state_code" text,
	"default_city_id" uuid,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_table" text,
	"entity_id" uuid,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_table" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"changed_by" uuid,
	"change_source" text NOT NULL,
	"staging_record_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"source_id" uuid,
	"url" text,
	"content_type" text,
	"blob_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staging_record_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" smallint DEFAULT 50 NOT NULL,
	"assigned_to" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_url" text,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"records_found" integer DEFAULT 0 NOT NULL,
	"records_staged" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staging_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"document_id" uuid,
	"entity_table" text NOT NULL,
	"entity_id" uuid,
	"match_key" text,
	"proposed" jsonb NOT NULL,
	"current" jsonb,
	"confidence" "confidence_level" DEFAULT 'medium' NOT NULL,
	"validation_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_by" text DEFAULT 'parser' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_provenance" ADD CONSTRAINT "fact_provenance_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_availability" ADD CONSTRAINT "variant_availability_variant_id_vehicle_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."vehicle_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_variants" ADD CONSTRAINT "vehicle_variants_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electricity_tariffs" ADD CONSTRAINT "electricity_tariffs_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_prices" ADD CONSTRAINT "fuel_prices_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_on_road_factors" ADD CONSTRAINT "state_on_road_factors_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_compatibility" ADD CONSTRAINT "e20_compatibility_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_compatibility" ADD CONSTRAINT "e20_compatibility_variant_id_vehicle_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."vehicle_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_compatibility" ADD CONSTRAINT "e20_compatibility_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_guidance_rules" ADD CONSTRAINT "e20_guidance_rules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_kb_chunks" ADD CONSTRAINT "e20_kb_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_stations" ADD CONSTRAINT "fuel_stations_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_stations" ADD CONSTRAINT "fuel_stations_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_density" ADD CONSTRAINT "infra_density_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_density" ADD CONSTRAINT "infra_density_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_assessments" ADD CONSTRAINT "e20_assessments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e20_assessments" ADD CONSTRAINT "e20_assessments_variant_id_vehicle_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."vehicle_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_vehicles" ADD CONSTRAINT "saved_vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_vehicles" ADD CONSTRAINT "saved_vehicles_variant_id_vehicle_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."vehicle_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_change_log" ADD CONSTRAINT "data_change_log_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_documents" ADD CONSTRAINT "raw_documents_job_id_scrape_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_documents" ADD CONSTRAINT "raw_documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_staging_record_id_staging_records_id_fk" FOREIGN KEY ("staging_record_id") REFERENCES "public"."staging_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD CONSTRAINT "scrape_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_records" ADD CONSTRAINT "staging_records_job_id_scrape_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_records" ADD CONSTRAINT "staging_records_document_id_raw_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."raw_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cities_slug_key" ON "cities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cities_state_idx" ON "cities" USING btree ("state_code");--> statement-breakpoint
CREATE UNIQUE INDEX "states_name_key" ON "states" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "data_quality_entity_key" ON "data_quality" USING btree ("entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "data_quality_score_idx" ON "data_quality" USING btree ("score");--> statement-breakpoint
CREATE INDEX "fact_provenance_entity_idx" ON "fact_provenance" USING btree ("entity_table","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_provenance_current_key" ON "fact_provenance" USING btree ("entity_table","entity_id","field") WHERE superseded_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_slug_key" ON "sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sources_tier_idx" ON "sources" USING btree ("tier");--> statement-breakpoint
CREATE UNIQUE INDEX "manufacturers_slug_key" ON "manufacturers" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_availability_key" ON "variant_availability" USING btree ("variant_id","state_code");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_models_slug_key" ON "vehicle_models" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "vehicle_models_manufacturer_idx" ON "vehicle_models" USING btree ("manufacturer_id");--> statement-breakpoint
CREATE INDEX "vehicle_models_category_body_idx" ON "vehicle_models" USING btree ("category","body_type","segment");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_variants_slug_key" ON "vehicle_variants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "vehicle_variants_model_idx" ON "vehicle_variants" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "vehicle_variants_candidate_idx" ON "vehicle_variants" USING btree ("fuel_type","ex_showroom_paise","seating_capacity") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "vehicle_variants_payload_idx" ON "vehicle_variants" USING btree ("payload_kg") WHERE status = 'active' and payload_kg is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "battery_costs_key" ON "battery_costs" USING btree ("chemistry","as_of");--> statement-breakpoint
CREATE INDEX "electricity_tariffs_lookup_idx" ON "electricity_tariffs" USING btree ("state_code","tariff_kind","as_of");--> statement-breakpoint
CREATE INDEX "emission_factors_lookup_idx" ON "emission_factors" USING btree ("fuel_type","state_code","as_of");--> statement-breakpoint
CREATE INDEX "finance_rates_lookup_idx" ON "finance_rates" USING btree ("category","fuel_type","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_prices_key" ON "fuel_prices" USING btree ("state_code","city_id","fuel_type","as_of");--> statement-breakpoint
CREATE INDEX "fuel_prices_latest_idx" ON "fuel_prices" USING btree ("state_code","fuel_type","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_curves_key" ON "maintenance_curves" USING btree ("segment","fuel_type","category","ownership_year","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "resale_curves_key" ON "resale_curves" USING btree ("segment","fuel_type","category","age_years","as_of");--> statement-breakpoint
CREATE INDEX "state_on_road_lookup_idx" ON "state_on_road_factors" USING btree ("state_code","category","fuel_type","price_band_min_paise");--> statement-breakpoint
CREATE INDEX "e20_compat_model_idx" ON "e20_compatibility" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e20_compat_variant_key" ON "e20_compatibility" USING btree ("variant_id") WHERE variant_id is not null;--> statement-breakpoint
CREATE INDEX "e20_guidance_lookup_idx" ON "e20_guidance_rules" USING btree ("applies_to_verdict","min_risk_level","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "e20_kb_chunk_key" ON "e20_kb_chunks" USING btree ("document_slug","chunk_index");--> statement-breakpoint
CREATE INDEX "e20_kb_fts_idx" ON "e20_kb_chunks" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || "content"));--> statement-breakpoint
CREATE INDEX "e20_kb_embedding_idx" ON "e20_kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_stations_external_key" ON "fuel_stations" USING btree ("type","external_id");--> statement-breakpoint
CREATE INDEX "fuel_stations_city_idx" ON "fuel_stations" USING btree ("city_id","type");--> statement-breakpoint
CREATE INDEX "fuel_stations_geo_idx" ON "fuel_stations" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_density_key" ON "infra_density" USING btree ("city_id","state_code","type","as_of");--> statement-breakpoint
CREATE INDEX "infra_density_lookup_idx" ON "infra_density" USING btree ("city_id","type");--> statement-breakpoint
CREATE INDEX "e20_assessments_user_idx" ON "e20_assessments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_run_idx" ON "feedback" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_calls_purpose_idx" ON "llm_calls" USING btree ("purpose","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_email_idx" ON "otp_codes" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "recommendation_runs_user_idx" ON "recommendation_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "recommendation_runs_bucket_idx" ON "recommendation_runs" USING btree ("profile_bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_share_token_key" ON "reports" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_vehicles_key" ON "saved_vehicles" USING btree ("user_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "data_change_log_entity_idx" ON "data_change_log" USING btree ("entity_table","entity_id","changed_at");--> statement-breakpoint
CREATE INDEX "raw_documents_hash_idx" ON "raw_documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "review_queue_status_idx" ON "review_queue" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "scrape_jobs_status_idx" ON "scrape_jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "scrape_jobs_source_idx" ON "scrape_jobs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "staging_records_entity_idx" ON "staging_records" USING btree ("entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "staging_records_job_idx" ON "staging_records" USING btree ("job_id");