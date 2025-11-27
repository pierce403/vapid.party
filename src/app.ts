import express, { Request, Response } from 'express';
import { generalLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import appsRouter from './routes/apps';
import vapidRouter from './routes/vapid';
import subscriptionsRouter from './routes/subscriptions';
import notificationsRouter from './routes/notifications';
import logger from './utils/logger';

export function createApp() {
  const app = express();
  
  // Trust proxy for rate limiting (needed for Vercel)
  app.set('trust proxy', 1);
  
  // Middleware
  app.use(express.json());
  app.use(requestLogger);
  app.use(generalLimiter);
  
  // Health check endpoint
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString()
      }
    });
  });
  
  // API Routes
  app.use('/api/apps', appsRouter);
  app.use('/api/vapid', vapidRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/notifications', notificationsRouter);
  
  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Not found'
    });
  });
  
  // Error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: unknown) => {
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      path: req.path
    });
    
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  });
  
  return app;
}

export default createApp;
