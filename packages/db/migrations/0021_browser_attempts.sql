CREATE TABLE "browser_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" uuid,
	"request_id" uuid,
	"kind" text NOT NULL,
	"portal_id" text,
	"target" text,
	"outcome" text NOT NULL,
	"code" text,
	"message" text,
	"error" jsonb,
	"detail" jsonb,
	"steps" jsonb NOT NULL,
	"screenshot" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "state_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_refresh_requests" ADD COLUMN "picked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_attempts" ADD CONSTRAINT "browser_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_attempts" ADD CONSTRAINT "browser_attempts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_attempts" ADD CONSTRAINT "browser_attempts_request_id_site_refresh_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."site_refresh_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_attempts_user_idx" ON "browser_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "browser_attempts_code_idx" ON "browser_attempts" USING btree ("code","created_at");