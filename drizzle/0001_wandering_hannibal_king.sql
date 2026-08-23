CREATE INDEX "manufacturers_name_trgm_idx" ON "manufacturers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vehicle_models_name_trgm_idx" ON "vehicle_models" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vehicle_models_advantages_idx" ON "vehicle_models" USING gin ("known_advantages");--> statement-breakpoint
CREATE INDEX "vehicle_models_disadvantages_idx" ON "vehicle_models" USING gin ("known_disadvantages");--> statement-breakpoint
CREATE INDEX "vehicle_models_common_problems_idx" ON "vehicle_models" USING gin ("common_problems");--> statement-breakpoint
CREATE INDEX "vehicle_variants_name_trgm_idx" ON "vehicle_variants" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vehicle_variants_price_idx" ON "vehicle_variants" USING btree ("ex_showroom_paise") WHERE status = 'active' and ex_showroom_paise is not null;--> statement-breakpoint
CREATE INDEX "e20_guidance_body_types_idx" ON "e20_guidance_rules" USING gin ("applies_to_body_types");--> statement-breakpoint
CREATE INDEX "e20_kb_tags_idx" ON "e20_kb_chunks" USING gin ("tags");