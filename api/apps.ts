import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp as createAppDb, getAppByApiKey } from '../src/db/apps';
import logger from '../src/utils/logger';

// Simple in-memory rate limiting for serverless
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return true;
  }
  
  if (record.count >= limit) {
    return false;
  }
  
  record.count++;
  return true;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || 'unknown';
  
  if (req.method === 'POST') {
    // Rate limit: 10 app registrations per hour
    if (!checkRateLimit(`app:${ip}`, 10, 60 * 60 * 1000)) {
      res.status(429).json({
        success: false,
        error: 'Too many app registrations, please try again later'
      });
      return;
    }
    
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
      
      const app = createAppDb(name.trim());
      
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
  } else if (req.method === 'GET') {
    // Get current app info
    const apiKey = req.headers['x-api-key'] as string | undefined;
    
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'Missing X-API-Key header'
      });
      return;
    }
    
    const app = getAppByApiKey(apiKey);
    
    if (!app) {
      res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
      return;
    }
    
    res.status(200).json({
      success: true,
      data: {
        id: app.id,
        name: app.name,
        createdAt: app.createdAt
      }
    });
  } else {
    res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }
}
