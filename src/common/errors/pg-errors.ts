/** Reading Postgres errors without depending on driver classes. */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

export function pgError(err: unknown): PgErrorLike | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as PgErrorLike).code === 'string') {
    const e = err as PgErrorLike;
    // Postgres SQLSTATE codes are 5 characters; Node system errors (ECONNREFUSED…) are not.
    if (/^[0-9A-Z]{5}$/.test(e.code ?? '')) return e;
  }
  return undefined;
}

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = pgError(err);
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
};

/** Serialization failure / deadlock / lock timeout: safe to try again. */
export const isRetryableTx = (err: unknown): boolean => ['40001', '40P01', '55P03'].includes(pgError(err)?.code ?? '');
