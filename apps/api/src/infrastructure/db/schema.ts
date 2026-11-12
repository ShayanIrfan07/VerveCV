import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedFromId: uuid("rotated_from_id"),
    createdAt: timestamps.createdAt,
  },
  (table) => [uniqueIndex("sessions_refresh_token_hash_unique").on(table.refreshTokenHash)],
);

export const plans = pgTable("plans", {
  code: text("code").primaryKey(),
  active: boolean("active").notNull(),
  createdAt: timestamps.createdAt,
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planCode: text("plan_code")
    .notNull()
    .references(() => plans.code),
  provider: text("provider"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  status: text("status").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    evaluationsUsed: integer("evaluations_used").notNull().default(0),
    uploadBytesUsed: bigint("upload_bytes_used", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_counters_user_period_unique").on(table.userId, table.periodStart),
    check("usage_counters_evaluations_non_negative", sql`${table.evaluationsUsed} >= 0`),
    check("usage_counters_bytes_non_negative", sql`${table.uploadBytesUsed} >= 0`),
  ],
);

export const resumes = pgTable("resumes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  candidateType: text("candidate_type"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const resumeVersions = pgTable("resume_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  resumeId: uuid("resume_id")
    .notNull()
    .references(() => resumes.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  objectKey: text("object_key").notNull(),
  parserVersion: text("parser_version"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletionState: text("deletion_state").notNull(),
  createdAt: timestamps.createdAt,
});

export const evaluationJobs = pgTable(
  "evaluation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resumeVersionId: uuid("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    errorCode: text("error_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamps.createdAt,
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("evaluation_jobs_user_idempotency_unique").on(table.userId, table.idempotencyKey)],
);

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resumeVersionId: uuid("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => evaluationJobs.id, { onDelete: "cascade" }),
    rubricVersion: text("rubric_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    baseScore: integer("base_score"),
    penaltyTotal: integer("penalty_total"),
    finalScore: integer("final_score"),
    scoreStatus: text("score_status").notNull(),
    categoriesJson: jsonb("categories_json"),
    jdMatchJson: jsonb("jd_match_json"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    check(
      "evaluations_final_score_range",
      sql`${table.finalScore} is null or (${table.finalScore} >= 0 and ${table.finalScore} <= 100)`,
    ),
  ],
);

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  evaluationId: uuid("evaluation_id")
    .notNull()
    .references(() => evaluations.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  suggestion: text("suggestion"),
  evidenceJson: jsonb("evidence_json").notNull(),
  confidence: text("confidence").notNull(),
  createdAt: timestamps.createdAt,
});

export const ignoredTerms = pgTable(
  "ignored_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    normalizedTerm: text("normalized_term").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [uniqueIndex("ignored_terms_user_term_unique").on(table.userId, table.normalizedTerm)],
);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  targetId: text("target_id"),
  safeMetadata: jsonb("safe_metadata").notNull(),
  createdAt: timestamps.createdAt,
});

export const retentionTasks = pgTable("retention_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  resumeVersionId: uuid("resume_version_id")
    .notNull()
    .references(() => resumeVersions.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  lastErrorCode: text("last_error_code"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
