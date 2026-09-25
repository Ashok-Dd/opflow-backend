import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CamelCasePlugin, Kysely, PostgresDialect, QueryResult, RawBuilder, sql, Transaction } from 'kysely';
import { Pool, PoolConfig, types } from 'pg';

import { ENV, Env } from '../../config/env';
import type { DB } from './schema';

/** Who a query runs as. Row-level security in the database uses these values (migration …001300). */
export type Identity =
  | { role: 'patient'; userId: string }
  | { role: 'doctor'; userId: string; doctorId: string }
  | { role: 'admin'; adminId: string }
  | { role: 'system' }
  | { role: 'public' };

export type Tx = Transaction<DB>;

// `date` columns stay 'YYYY-MM-DD' strings (an Indian calendar day), never a JavaScript Date that could shift
// by a day with the server's time zone. Matches `db:types --date-parser string`.
types.setTypeParser(1082, (v: string) => v);

/**
 * The one way the app talks to Postgres (Supabase, through the transaction pooler, as `opflow_api`).
 *
 * - `db` for reads of public, non-personal tables (catalog, hospitals, doctor cards).
 * - `as(identity, fn)` for everything else: runs `fn` in a transaction that first tells the database who is
 *   calling, so row-level security applies. The settings are transaction-local (`set_config(…, true)`),
 *   which is exactly what transaction pooling needs.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  readonly pool: Pool;
  readonly db: Kysely<DB>;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.pool = new Pool(poolConfig(env, this.log));
    this.pool.on('error', (err) => this.log.error(`Idle database connection error: ${err.message}`));
    // A connection that drops while checked out (network blip, Supabase restart) must not crash the process:
    // its query fails with an error, the pool drops it, and the next request gets a fresh one.
    this.pool.on('connect', (client) => client.on('error', (err) => this.log.warn(`Database connection lost: ${err.message}`)));
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }), plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })] });
  }

  async as<T>(who: Identity, fn: (tx: Tx) => Promise<T>, timeoutMs = this.env.DB_STATEMENT_TIMEOUT_MS): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const role = who.role === 'public' ? 'none' : who.role;
      const userId = 'userId' in who ? who.userId : '';
      const doctorId = 'doctorId' in who ? who.doctorId : '';
      await sql`select set_config('app.role', ${role}, true),
                       set_config('app.user_id', ${userId}, true),
                       set_config('app.doctor_id', ${doctorId}, true)`.execute(tx);
      await sql.raw(`set local statement_timeout = ${Math.trunc(timeoutMs)}`).execute(tx);
      return fn(tx);
    });
  }

  /** Shorthand for background work and server-side bookkeeping (row-level security: staff). */
  system<T>(fn: (tx: Tx) => Promise<T>, timeoutMs?: number): Promise<T> {
    return this.as({ role: 'system' }, fn, timeoutMs);
  }

  /**
   * One raw query as `system`. Needed for anything touching tables with row-level security (bookings,
   * queue entries, profiles, notifications): outside a role those tables show NO rows, by design.
   */
  sys<R>(query: RawBuilder<R>): Promise<QueryResult<R>> {
    return this.system((tx) => query.execute(tx));
  }

  private pgcrypto?: Promise<string>;

  /**
   * Where pgcrypto's functions live: `extensions` on Supabase, `public` on plain Postgres. Looked up once and
   * used fully qualified (e.g. `extensions.pgp_sym_encrypt`), so no connection's search_path matters.
   */
  cryptoSchema(): Promise<string> {
    this.pgcrypto ??= sql<{ nspname: string }>`
      select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.proname = 'pgp_sym_encrypt' order by (n.nspname = 'public') desc limit 1`
      .execute(this.db)
      .then((r) => {
        const schema = r.rows[0]?.nspname;
        if (!schema || !/^[a-z_]+$/.test(schema)) throw new Error('pgcrypto is not installed');
        return schema;
      })
      .catch((err: unknown) => {
        this.pgcrypto = undefined;
        throw err;
      });
    return this.pgcrypto;
  }

  /** For /ready: a quick round trip to the database. */
  async ping(): Promise<number> {
    const started = Date.now();
    await sql`select 1`.execute(this.db);
    return Date.now() - started;
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * Builds the pg pool settings from DATABASE_URL. The URL's query options (`pgbouncer`, `connection_limit`,
 * `sslmode`) are for other tools; here SSL and pool size are set explicitly.
 */
export function poolConfig(env: Env, log?: Pick<Logger, 'warn'>): PoolConfig {
  const url = new URL(env.DATABASE_URL);
  const ssl: PoolConfig['ssl'] = env.DB_SSL_CA_B64
    ? { ca: Buffer.from(env.DB_SSL_CA_B64, 'base64').toString('utf8'), rejectUnauthorized: true }
    : { rejectUnauthorized: false };
  if (!env.DB_SSL_CA_B64) {
    // Only allowed on APP_ENV=local (env.ts refuses it elsewhere).
    log?.warn('DB_SSL_CA_B64 is not set: the database certificate is NOT verified (local development only).');
  }
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || 'postgres',
    ssl: url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : ssl,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: env.DB_STATEMENT_TIMEOUT_MS + 2_000, // client-side guard on top of the server timeout
    application_name: `opflow-${env.PROCESS_TYPE}`,
  };
}
