import postgres from "postgres";

let client: ReturnType<typeof postgres> | null = null;

/** Shared Neon/Postgres client, lazily initialized. */
export function getSql(): ReturnType<typeof postgres> {
  if (!client) {
    const url = process.env["NEON_DATABASE_URL"] || process.env["DATABASE_URL"];
    if (!url) throw new Error("NEON_DATABASE_URL is not set");
    const useSsl = !/sslmode=disable/.test(url);
    client = postgres(url, { ssl: useSsl ? "require" : false, max: 5, idle_timeout: 30 });
  }
  return client;
}
