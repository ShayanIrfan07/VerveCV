import { hash, verify } from "@node-rs/argon2";

/** OWASP Password Storage Cheat Sheet minimum: Argon2id, 19 MiB, 2 passes, parallelism 1. */
const ARGON2ID = 2;
const MEMORY_COST_KIB = 19_456;
const TIME_COST = 2;
const PARALLELISM = 1;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: ARGON2ID,
    memoryCost: MEMORY_COST_KIB,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
