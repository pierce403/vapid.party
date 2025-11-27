import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  verifyWalletAuth,
  verifyAppOwnership,
  corsHeaders,
  corsResponse,
} from '@/lib/api-utils';
import { regenerateApiKey } from '@/lib/db';
import { ErrorCodes } from '@/lib/types';
import logger from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function OPTIONS() {
  return corsResponse();
}

// Regenerate API key for an app
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    const authResult = await verifyWalletAuth(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { walletAddress } = authResult;
    const isOwner = await verifyAppOwnership(walletAddress, id);

    if (!isOwner) {
      return errorResponse('App not found', ErrorCodes.NOT_FOUND, 404);
    }

    const newApiKey = await regenerateApiKey(id);
    if (!newApiKey) {
      return errorResponse('App not found', ErrorCodes.NOT_FOUND, 404);
    }

    logger.info('API key regenerated', { appId: id, walletAddress });

    const response = NextResponse.json(
      {
        success: true,
        data: { apiKey: newApiKey },
      },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to regenerate API key', error);
    return errorResponse(
      'Failed to regenerate API key',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}

