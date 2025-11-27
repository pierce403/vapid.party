import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

// Skip rate limiting in test environment
const skipInTest = process.env.NODE_ENV === 'test';

// General API rate limit
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });
    res.status(options.statusCode).json(options.message);
  }
});

// Stricter limit for app registration
export const appRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 app registrations per hour
  message: {
    success: false,
    error: 'Too many app registrations, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
  handler: (req, res, next, options) => {
    logger.warn('App registration rate limit exceeded', {
      ip: req.ip
    });
    res.status(options.statusCode).json(options.message);
  }
});

// Rate limit for sending notifications
export const notificationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 notifications per minute
  message: {
    success: false,
    error: 'Too many notification requests, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
  keyGenerator: (req) => {
    // Rate limit by API key if present, otherwise by IP
    const apiKey = req.headers['x-api-key'] as string | undefined;
    return apiKey || req.ip || 'unknown';
  },
  handler: (req, res, next, options) => {
    logger.warn('Notification rate limit exceeded', {
      ip: req.ip,
      appId: req.app_data?.id
    });
    res.status(options.statusCode).json(options.message);
  }
});
