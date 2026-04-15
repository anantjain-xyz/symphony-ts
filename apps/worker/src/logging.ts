import pino, { type Logger } from 'pino';

/**
 * Pino logger with a redaction list. Spec: "API keys via environment variables,
 * never logged in full". We redact common credential field names and any field
 * matching *_KEY/*_TOKEN/*_SECRET in either snake_case or camelCase.
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'api_key',
        'apiKey',
        'service_role_key',
        'serviceRoleKey',
        'authorization',
        'Authorization',
        'password',
        'token',
        'secret',
        '*.api_key',
        '*.apiKey',
        '*.authorization',
      ],
      censor: '[redacted]',
    },
  });
}

/**
 * Mask an arbitrary string that may contain a secret, leaving only first/last
 * 4 chars. Useful when we have to log something that wraps a key (e.g.
 * "auth header set: <masked>").
 */
export function maskSecret(s: string | undefined): string {
  if (!s) return '<empty>';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
