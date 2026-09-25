import { Body, HttpStatus, Param, ParseUUIDPipe, PipeTransform, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import { AppError } from '../errors/app-error';

/**
 * Request validation with zod. A bad request gets one clear message plus the fields that are wrong:
 * { code: 'INVALID_INPUT', message: 'Please check: fee', details: { fields: { fee: '...' } } }.
 */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || 'body';
      fields[key] ??= issue.message;
    }
    throw new AppError(
      'INVALID_INPUT',
      `Please check: ${Object.keys(fields).slice(0, 3).join(', ')}`,
      HttpStatus.BAD_REQUEST,
      false,
      { fields },
    );
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

/** Validated body; also documents the body in OpenAPI. */
export function ZBody(schema: z.ZodType): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodPipe(schema))(target, key, index);
    const descriptor = key ? Object.getOwnPropertyDescriptor(target, key) : undefined;
    if (key && descriptor) ApiBody({ schema: jsonSchema(schema) })(target, key, descriptor);
  };
}

/** Validated query string; also documents each query parameter in OpenAPI. */
export function ZQuery(schema: z.ZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodPipe(schema))(target, key, index);
    const descriptor = key ? Object.getOwnPropertyDescriptor(target, key) : undefined;
    if (!key || !descriptor) return;
    for (const [name, field] of Object.entries(schema.shape)) {
      const optional = (field as z.ZodType).safeParse(undefined).success;
      ApiQuery({ name, required: !optional, schema: jsonSchema(field as z.ZodType) })(target, key, descriptor);
    }
  };
}

/** A path id that must be a UUID (anything else is a clean 404, not a database error). */
export const IdParam = (name = 'id'): ParameterDecorator =>
  Param(
    name,
    new ParseUUIDPipe({
      exceptionFactory: () => new AppError('NOT_FOUND', 'We could not find this. It may have been moved or removed.', HttpStatus.NOT_FOUND),
    }),
  );

// Shared field shapes (simple English messages).
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-09-25');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 09:30');
export const zPhone = z.string().regex(/^\+91[6-9]\d{9}$/, 'must be an Indian mobile number like +919876543210');
export const zUuid = z.uuid('must be a valid id');
export const zCursor = z.string().max(200).optional();
export const zLimit = z.coerce.number().int().min(1).max(50).default(20);
export const zBoolString = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Offset-based cursors, opaque to the client. */
export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : 0;
}

export function page<T>(rows: T[], offset: number, limit: number): { items: T[]; nextCursor: string | null } {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null };
}
