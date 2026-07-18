import type { ApiResponse } from './types';
import type { ZodError } from 'zod';

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_API_KEY: 'INVALID_API_KEY',
  APP_NOT_FOUND: 'APP_NOT_FOUND',
  PUSH_FAILED: 'PUSH_FAILED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  DNS_LOOKUP_FAILED: 'DNS_LOOKUP_FAILED',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Internal-Token, X-Vapid-Party-Diagnostics, X-Vapid-Party-Management-Token',
  };
}

export function jsonResponse<T>(data: T, status = 200): Response {
  return Response.json({ success: true, data } satisfies ApiResponse<T>, {
    status,
    headers: corsHeaders(),
  });
}

export function errorResponse(
  error: string,
  code: ErrorCode,
  status: number,
  details?: unknown
): Response {
  return Response.json({ success: false, error, code, details } satisfies ApiResponse, {
    status,
    headers: corsHeaders(),
  });
}

function fieldPath(path: Array<string | number>): string {
  let out = '';
  for (const segment of path) {
    out = typeof segment === 'number'
      ? `${out}[${segment}]`
      : out
        ? `${out}.${segment}`
        : segment;
  }
  return out;
}

function valueAtPath(input: unknown, path: Array<string | number>): unknown {
  let current = input;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function zodErrorResponse(error: ZodError, input: unknown): Response {
  return errorResponse('Validation failed', ERROR_CODES.VALIDATION_ERROR, 422, {
    issues: error.errors.map((issue) => ({
      fieldPath: fieldPath(issue.path),
      message: issue.message,
      code: issue.code,
      value: valueAtPath(input, issue.path),
    })),
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

export async function readJsonBounded(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}
