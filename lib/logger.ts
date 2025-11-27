import winston from 'winston';

const { combine, timestamp, json, printf, colorize } = winston.format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}]: ${message}${metaStr}`;
});

// Create logger based on environment
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  defaultMeta: { service: 'vapid-party' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? combine(timestamp(), json())
        : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), devFormat),
    }),
  ],
});

// Structured logging helpers
export function logApiRequest(
  method: string,
  path: string,
  ip: string | undefined,
  appId?: string
) {
  logger.info('API Request', {
    method,
    path,
    ip: ip || 'unknown',
    appId,
  });
}

export function logApiResponse(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number
) {
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  logger.log(level, 'API Response', {
    method,
    path,
    statusCode,
    durationMs,
  });
}

export function logNotificationSent(
  appId: string,
  subscriptionId: string,
  success: boolean,
  statusCode?: number
) {
  logger.info('Notification sent', {
    appId,
    subscriptionId,
    success,
    statusCode,
  });
}

export function logRateLimitExceeded(
  appId: string,
  limitType: string,
  current: number,
  limit: number
) {
  logger.warn('Rate limit exceeded', {
    appId,
    limitType,
    current,
    limit,
  });
}

export function logAuthFailure(
  reason: string,
  ip: string | undefined,
  details?: Record<string, unknown>
) {
  logger.warn('Authentication failed', {
    reason,
    ip: ip || 'unknown',
    ...details,
  });
}

export function logError(
  message: string,
  error: unknown,
  context?: Record<string, unknown>
) {
  const errorDetails = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { error };
  
  logger.error(message, {
    ...errorDetails,
    ...context,
  });
}

export default logger;

