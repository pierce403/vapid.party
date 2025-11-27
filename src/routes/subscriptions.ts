import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth';
import { createSubscription, getSubscriptionById, listSubscriptionsByApp, deleteSubscription } from '../db/subscriptions';
import logger from '../utils/logger';

const router = Router();

// All subscription endpoints require authentication
router.use(authenticateApiKey);

// Create a new subscription
router.post('/', (req: Request, res: Response) => {
  try {
    const { endpoint, keys } = req.body;
    const app = req.app_data;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    // Validate required fields
    if (!endpoint || typeof endpoint !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Valid endpoint URL is required'
      });
      return;
    }
    
    if (!keys || !keys.p256dh || !keys.auth) {
      res.status(400).json({
        success: false,
        error: 'Subscription keys (p256dh and auth) are required'
      });
      return;
    }
    
    // Basic URL validation
    try {
      new URL(endpoint);
    } catch {
      res.status(400).json({
        success: false,
        error: 'Invalid endpoint URL'
      });
      return;
    }
    
    const subscription = createSubscription({
      appId: app.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth
    });
    
    res.status(201).json({
      success: true,
      data: {
        id: subscription.id,
        endpoint: subscription.endpoint,
        createdAt: subscription.createdAt
      }
    });
  } catch (error) {
    logger.error('Error creating subscription', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to create subscription'
    });
  }
});

// List all subscriptions for the authenticated app
router.get('/', (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    const subscriptions = listSubscriptionsByApp(app.id);
    
    res.json({
      success: true,
      data: subscriptions.map(sub => ({
        id: sub.id,
        endpoint: sub.endpoint,
        createdAt: sub.createdAt
      }))
    });
  } catch (error) {
    logger.error('Error listing subscriptions', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to list subscriptions'
    });
  }
});

// Get a specific subscription
router.get('/:id', (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    const { id } = req.params;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    const subscription = getSubscriptionById(id);
    
    if (!subscription) {
      res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
      return;
    }
    
    // Check ownership
    if (subscription.appId !== app.id) {
      res.status(403).json({
        success: false,
        error: 'Access denied'
      });
      return;
    }
    
    res.json({
      success: true,
      data: {
        id: subscription.id,
        endpoint: subscription.endpoint,
        createdAt: subscription.createdAt
      }
    });
  } catch (error) {
    logger.error('Error getting subscription', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription'
    });
  }
});

// Delete a subscription by ID
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    const { id } = req.params;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    const subscription = getSubscriptionById(id);
    
    if (!subscription) {
      res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
      return;
    }
    
    // Check ownership
    if (subscription.appId !== app.id) {
      res.status(403).json({
        success: false,
        error: 'Access denied'
      });
      return;
    }
    
    const deleted = deleteSubscription(id);
    
    if (deleted) {
      res.json({
        success: true,
        message: 'Subscription deleted successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete subscription'
      });
    }
  } catch (error) {
    logger.error('Error deleting subscription', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to delete subscription'
    });
  }
});

export default router;
