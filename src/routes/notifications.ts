import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth';
import { notificationLimiter } from '../middleware/rateLimiter';
import { sendNotification, sendNotificationDirect } from '../services/notifications';
import { getSubscriptionById, listSubscriptionsByApp } from '../db/subscriptions';
import logger from '../utils/logger';
import type { NotificationPayload } from '../types';

const router = Router();

// All notification endpoints require authentication
router.use(authenticateApiKey);
router.use(notificationLimiter);

// Validate notification payload
function validatePayload(payload: unknown): payload is NotificationPayload {
  if (!payload || typeof payload !== 'object') return false;
  
  const p = payload as Record<string, unknown>;
  
  if (!p.title || typeof p.title !== 'string') return false;
  if (p.body !== undefined && typeof p.body !== 'string') return false;
  if (p.icon !== undefined && typeof p.icon !== 'string') return false;
  if (p.badge !== undefined && typeof p.badge !== 'string') return false;
  
  return true;
}

// Send notification to a specific subscription by ID
router.post('/send', async (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    const { subscriptionId, endpoint, keys, payload } = req.body;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    if (!validatePayload(payload)) {
      res.status(400).json({
        success: false,
        error: 'Invalid notification payload. Required: title (string)'
      });
      return;
    }
    
    // Option 1: Send by subscription ID
    if (subscriptionId) {
      const subscription = getSubscriptionById(subscriptionId);
      
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
      
      const result = await sendNotification(subscription, payload);
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            subscriptionId: result.subscriptionId,
            statusCode: result.statusCode
          }
        });
      } else {
        res.status(502).json({
          success: false,
          error: result.error
        });
      }
      return;
    }
    
    // Option 2: Send directly with endpoint and keys
    if (endpoint && keys && keys.p256dh && keys.auth) {
      const result = await sendNotificationDirect(endpoint, keys.p256dh, keys.auth, payload);
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            endpoint: result.endpoint,
            statusCode: result.statusCode
          }
        });
      } else {
        res.status(502).json({
          success: false,
          error: result.error
        });
      }
      return;
    }
    
    res.status(400).json({
      success: false,
      error: 'Either subscriptionId or (endpoint + keys.p256dh + keys.auth) is required'
    });
  } catch (error) {
    logger.error('Error sending notification', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to send notification'
    });
  }
});

// Send notification to all subscriptions of the app
router.post('/broadcast', async (req: Request, res: Response) => {
  try {
    const app = req.app_data;
    const { payload } = req.body;
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }
    
    if (!validatePayload(payload)) {
      res.status(400).json({
        success: false,
        error: 'Invalid notification payload. Required: title (string)'
      });
      return;
    }
    
    const subscriptions = listSubscriptionsByApp(app.id);
    
    if (subscriptions.length === 0) {
      res.json({
        success: true,
        data: {
          sent: 0,
          failed: 0,
          total: 0
        }
      });
      return;
    }
    
    const results = await Promise.all(
      subscriptions.map(sub => sendNotification(sub, payload))
    );
    
    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      data: {
        sent,
        failed,
        total: subscriptions.length,
        failures: results
          .filter(r => !r.success)
          .map(r => ({
            subscriptionId: r.subscriptionId,
            error: r.error
          }))
      }
    });
  } catch (error) {
    logger.error('Error broadcasting notification', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to broadcast notification'
    });
  }
});

export default router;
