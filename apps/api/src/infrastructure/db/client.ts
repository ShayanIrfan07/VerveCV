import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string): Database {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}

export type Database = PostgresJsDatabase<typeof schema>;
