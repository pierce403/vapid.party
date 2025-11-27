import { Router, Request, Response } from 'express';
import { getVapidPublicKey } from '../db/vapidKeys';
import logger from '../utils/logger';

const router = Router();

// Get VAPID public key (public endpoint)
router.get('/public-key', (req: Request, res: Response) => {
  try {
    const publicKey = getVapidPublicKey();
    
    res.json({
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
});

export default router;
