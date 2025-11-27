import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAppByApiKey } from '../src/db/apps';
import { getSubscriptionById, listSubscriptionsByApp } from '../src/db/subscriptions';
import { sendNotification, sendNotificationDirect } from '../src/services/notifications';
import logger from '../src/utils/logger';
import type { NotificationPayload } from '../src/types';

// Simple in-memory rate limiting for serverless
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(key);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  
  if (record.count >= limit) {
    return false;
  }
  
  record.count++;
  return true;
}

function validatePayload(payload: unknown): payload is NotificationPayload {
  if (!payload || typeof payload !== 'object') return false;
  
  const p = payload as Record<string, unknown>;
  
  if (!p.title || typeof p.title !== 'string') return false;
  if (p.body !== undefined && typeof p.body !== 'string') return false;
  if (p.icon !== undefined && typeof p.icon !== 'string') return false;
  if (p.badge !== undefined && typeof p.badge !== 'string') return false;
  
  return true;
}

function authenticate(req: VercelRequest, res: VercelResponse) {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: 'Missing X-API-Key header'
    });
    return null;
  }
  
  const app = getAppByApiKey(apiKey);
  
  if (!app) {
    res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
    return null;
  }
  
  return app;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
    return;
  }
  
  const app = authenticate(req, res);
  if (!app) return;
  
  // Rate limit: 60 notifications per minute per app
  if (!checkRateLimit(`notify:${app.id}`, 60, 60 * 1000)) {
    res.status(429).json({
      success: false,
      error: 'Too many notification requests, please try again later'
    });
    return;
  }
  
  const { action } = req.query;
  
  try {
    if (action === 'broadcast') {
      // Broadcast to all subscriptions
      const { payload } = req.body;
      
      if (!validatePayload(payload)) {
        res.status(400).json({
          success: false,
          error: 'Invalid notification payload. Required: title (string)'
        });
        return;
      }
      
      const subscriptions = listSubscriptionsByApp(app.id);
      
      if (subscriptions.length === 0) {
        res.status(200).json({
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
      
      res.status(200).json({
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
    } else {
      // Send to single subscription
      const { subscriptionId, endpoint, keys, payload } = req.body;
      
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
          res.status(200).json({
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
          res.status(200).json({
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
    }
  } catch (error) {
    logger.error('Error sending notification', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to send notification'
    });
  }
}
