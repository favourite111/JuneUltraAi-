import postgres from "postgres";

let client: ReturnType<typeof postgres> | null = null;

/** Shared Neon/Postgres client, lazily initialized. */
export function getSql(): ReturnType<typeof postgres> {
  if (!client) {
    const url = process.env["NEON_DATABASE_URL"];
    if (!url) throw new Error("NEON_DATABASE_URL is not set");
    client = postgres(url, { ssl: "require", max: 5, idle_timeout: 30 });
  }
  return client;
}
