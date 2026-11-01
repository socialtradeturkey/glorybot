import { neon } from "@neondatabase/serverless";

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not configured.");
    this.name = "DatabaseNotConfiguredError";
  }
}

let cachedUrl: string | undefined;
let cachedClient: ReturnType<typeof neon> | undefined;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDatabase() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new DatabaseNotConfiguredError();

  if (!cachedClient || cachedUrl !== connectionString) {
    cachedClient = neon(connectionString);
    cachedUrl = connectionString;
  }

  return cachedClient;
}
