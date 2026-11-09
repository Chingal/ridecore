import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DomainError } from '../domain/errors.ts';

export type ErrorInfo = { status: number; code: string; message: string };

export const INTERNAL_MESSAGE = 'Internal server error';

/** A DomainError keeps its status and code; anything else is 500 INTERNAL with a generic message. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof DomainError) return { status: err.status, code: err.code, message: err.message };
  return { status: 500, code: 'INTERNAL', message: INTERNAL_MESSAGE };
}

export function json(
  status: number,
  body: unknown,
  correlationId: string,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers, 'x-correlation-id': correlationId },
    body: JSON.stringify(body),
  };
}

/** `{"error":{"code","message"}}`, the only error body the API returns. */
export function errorJson(info: ErrorInfo, correlationId: string): APIGatewayProxyStructuredResultV2 {
  return json(info.status, { error: { code: info.code, message: info.message } }, correlationId);
}
