import { Router, Request, Response } from 'express';
import { createApp, deleteApp } from '../db/apps';
import { appRegistrationLimiter } from '../middleware/rateLimiter';
import { authenticateApiKey } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

// Register a new app (public endpoint with rate limiting)
router.post('/', appRegistrationLimiter, (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'App name is required'
      });
      return;
    }
    
    if (name.length > 255) {
      res.status(400).json({
        success: false,
        error: 'App name must be 255 characters or less'
      });
      return;
    }
    
    const app = createApp(name.trim());
    
    res.status(201).json({
      success: true,
      data: {
        id: app.id,
        name: app.name,
        apiKey: app.apiKey,
        createdAt: app.createdAt
      }
    });
  } catch (error) {
    logger.error('Error creating app', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to create app'
    });
  }
});

// Get current app info (requires auth)
router.get('/me', authenticateApiKey, (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    
    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found'
      });
      return;
    }
    
    res.json({
      success: true,
      data: {
        id: app.id,
        name: app.name,
        createdAt: app.createdAt
      }
    });
  } catch (error) {
    logger.error('Error getting app', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get app'
    });
  }
});

// Delete current app (requires auth)
router.delete('/me', authenticateApiKey, (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    
    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found'
      });
      return;
    }
    
    const deleted = deleteApp(app.id);
    
    if (deleted) {
      res.json({
        success: true,
        message: 'App deleted successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete app'
      });
    }
  } catch (error) {
    logger.error('Error deleting app', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to delete app'
    });
  }
});

export default router;
