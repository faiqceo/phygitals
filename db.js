// phygitals/db.js
// PostgreSQL access (Neon or any Postgres). Keeps the old db.prepare(sql).get/all/run style, but async.
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

/* BIGINT (int8) and NUMERIC come back as strings by default. Balances are micro-dollars and ids
   are small, so they fit a JS number safely; return numbers like the old SQLite driver did. */
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing. Set it to your Neon connection string, e.g.\n" +
      "postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require",
  );
  process.exit(1);
}
/* Optional: keep all tables in their own schema (used by the tests so several runs never clash). */
export const DATABASE_SCHEMA = (process.env.DATABASE_SCHEMA || "").trim();
if (DATABASE_SCHEMA && !/^[a-z_][a-z0-9_]*$/i.test(DATABASE_SCHEMA)) {
  console.error("DATABASE_SCHEMA may only contain letters, digits and underscores.");
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis: 10_000, // Neon suspends idle compute; do not hold stale connections
  connectionTimeoutMillis: 15_000,
  ...(DATABASE_SCHEMA ? { options: `-c search_path=${DATABASE_SCHEMA}` } : {}),
});
pool.on("error", (e) => console.error("Postgres pool error:", e.message));

/* Timestamps stay as UTC text "YYYY-MM-DD HH24:MI:SS" so existing code that formats them keeps working. */
export const NOW_TEXT = "to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')";

const als = new AsyncLocalStorage(); // holds the client of the running transaction
const toPg = (sql) => {
  let i = 0;
  return sql.replaceAll("CURRENT_TIMESTAMP", NOW_TEXT).replace(/\?/g, () => `$${++i}`);
};
const runner = () => als.getStore() || pool;

export const db = {
  prepare(sql) {
    const text = toPg(sql);
    return {
      get: async (...p) => (await runner().query(text, p)).rows[0],
      all: async (...p) => (await runner().query(text, p)).rows,
      run: async (...p) => {
        const r = await runner().query(text, p);
        return { changes: r.rowCount };
      },
    };
  },
  exec: (sql) => runner().query(sql.replaceAll("CURRENT_TIMESTAMP", NOW_TEXT)),
  close: () => pool.end(),
  /* tests only: remove the schema created by DATABASE_SCHEMA */
  dropSchema: async () => {
    if (DATABASE_SCHEMA) await pool.query(`DROP SCHEMA IF EXISTS "${DATABASE_SCHEMA}" CASCADE`);
  },
};

/* Runs fn in one transaction. Every db call made inside (even in helper functions) uses the same
   connection. A global advisory lock makes write transactions run one at a time, which is what
   SQLite's BEGIN IMMEDIATE did, so balance checks and updates can never interleave. */
export async function inTransaction(fn) {
  if (als.getStore()) return fn();
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7420002)");
    const result = await als.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

export const isUnique = (error) => !!error && error.code === "23505";
