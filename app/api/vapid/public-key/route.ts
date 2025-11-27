import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  authenticateApiKey,
  corsHeaders,
  corsResponse,
} from '@/lib/api-utils';
import { ErrorCodes } from '@/lib/types';
import logger from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsResponse();
}

// Get VAPID public key for an app (for client-side subscription)
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateApiKey(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { app } = authResult;

    const response = NextResponse.json(
      {
        success: true,
        data: {
          publicKey: app.vapidPublicKey,
        },
      },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to get VAPID public key', error);
    return errorResponse(
      'Failed to get VAPID public key',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}

