ALTER TABLE "flags" DROP CONSTRAINT "flags_key_unique";--> statement-breakpoint
ALTER TABLE "flags" ALTER COLUMN "targeting_rules" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "flags" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "flags_key_active_idx" ON "flags" USING btree ("key") WHERE "flags"."deleted_at" IS NULL;