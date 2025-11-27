import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  verifyWalletAuth,
  corsHeaders,
  corsResponse,
} from '@/lib/api-utils';
import { getAppsByOwner } from '@/lib/db';
import { ErrorCodes } from '@/lib/types';
import logger from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsResponse();
}

// List all apps for the authenticated wallet
export async function GET(request: NextRequest) {
  try {
    const authResult = await verifyWalletAuth(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { walletAddress } = authResult;
    const apps = await getAppsByOwner(walletAddress);

    const response = NextResponse.json(
      {
        success: true,
        data: apps.map((app) => ({
          id: app.id,
          name: app.name,
          apiKey: app.apiKey,
          vapidPublicKey: app.vapidPublicKey,
          metadata: app.metadata,
          rateLimit: app.rateLimit,
          createdAt: app.createdAt.toISOString(),
          updatedAt: app.updatedAt.toISOString(),
        })),
      },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to list apps', error);
    return errorResponse(
      'Failed to list apps',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}

