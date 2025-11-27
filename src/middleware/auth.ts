import { Request, Response, NextFunction } from 'express';
import { getAppByApiKey } from '../db/apps';
import logger from '../utils/logger';
import type { App } from '../types';

declare module 'express-serve-static-core' {
  interface Request {
    app_data?: App;
  }
}

export function authenticateApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  
  if (!apiKey) {
    logger.warn('Missing API key', { path: req.path, ip: req.ip });
    res.status(401).json({
      success: false,
      error: 'Missing X-API-Key header'
    });
    return;
  }
  
  const app = getAppByApiKey(apiKey);
  
  if (!app) {
    logger.warn('Invalid API key', { path: req.path, ip: req.ip });
    res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
    return;
  }
  
  req.app_data = app;
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  
  if (apiKey) {
    const app = getAppByApiKey(apiKey);
    if (app) {
      req.app_data = app;
    }
  }
  
  next();
}
