import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string): Database {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}

export function createDatabaseWithClient(databaseUrl: string): {
  db: Database;
  close: () => Promise<void>;
} {
  const client = postgres(databaseUrl, { max: 2 });
  return {
    db: drizzle(client, { schema }),
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

export type Database = PostgresJsDatabase<typeof schema>;
