import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAppByApiKey } from '../src/db/apps';
import { createSubscription, listSubscriptionsByApp, getSubscriptionById, deleteSubscription } from '../src/db/subscriptions';
import logger from '../src/utils/logger';

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

export default function handler(req: VercelRequest, res: VercelResponse) {
  const app = authenticate(req, res);
  if (!app) return;
  
  if (req.method === 'POST') {
    try {
      const { endpoint, keys } = req.body;
      
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
  } else if (req.method === 'GET') {
    try {
      const subscriptions = listSubscriptionsByApp(app.id);
      
      res.status(200).json({
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
  } else {
    res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }
}
