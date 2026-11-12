import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/api/src/infrastructure/db/schema.ts",
  out: "./database/migrations",
  dialect: "postgresql",
});
