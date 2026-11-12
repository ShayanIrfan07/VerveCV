ALTER TABLE "resume_versions" ADD COLUMN "verification_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_versions_resume_version_unique" ON "resume_versions" USING btree ("resume_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_versions_object_key_unique" ON "resume_versions" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "resume_versions_resume_id_idx" ON "resume_versions" USING btree ("resume_id");--> statement-breakpoint
CREATE INDEX "resumes_user_id_idx" ON "resumes" USING btree ("user_id");