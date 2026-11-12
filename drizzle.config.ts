import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const root = path.dirname(fileURLToPath(import.meta.url));
const rel = (target: string) =>
  (path.relative(process.cwd(), path.join(root, target)) || ".").replaceAll("\\", "/");

export default defineConfig({
  schema: rel("apps/api/src/infrastructure/db/schema.ts"),
  out: rel("database/migrations"),
  dialect: "postgresql",
});
