import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const root = path.dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/");

export default defineConfig({
  schema: `${root}/apps/api/src/infrastructure/db/schema.ts`,
  out: `${root}/database/migrations`,
  dialect: "postgresql",
});
