import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getVapidPublicKey } from '../../src/db/vapidKeys';
import logger from '../../src/utils/logger';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
    return;
  }
  
  try {
    const publicKey = getVapidPublicKey();
    
    res.status(200).json({
      success: true,
      data: {
        publicKey
      }
    });
  } catch (error) {
    logger.error('Error getting VAPID public key', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get VAPID public key'
    });
  }
}
