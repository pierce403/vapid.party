import { NextRequest, NextResponse } from 'next/server';
import {
  jsonResponse,
  errorResponse,
  verifyWalletAuth,
  corsHeaders,
  corsResponse,
  parseJsonBody,
} from '@/lib/api-utils';
import { createApp, getAppsByOwner } from '@/lib/db';
import { RegisterAppSchema, ErrorCodes } from '@/lib/types';
import logger from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Max apps per wallet
const MAX_APPS_PER_WALLET = 10;

export async function OPTIONS() {
  return corsResponse();
}

export async function POST(request: NextRequest) {
  try {
    // Verify wallet authentication
    const authResult = await verifyWalletAuth(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { walletAddress } = authResult;

    // Check existing apps limit
    const existingApps = await getAppsByOwner(walletAddress);
    if (existingApps.length >= MAX_APPS_PER_WALLET) {
      return errorResponse(
        `Maximum ${MAX_APPS_PER_WALLET} apps per wallet allowed`,
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        429
      );
    }

    // Parse and validate request body
    const body = await parseJsonBody(request);
    if (!body) {
      return errorResponse(
        'Invalid JSON body',
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }

    const parseResult = RegisterAppSchema.safeParse(body);
    if (!parseResult.success) {
      return errorResponse(
        parseResult.error.errors[0]?.message || 'Validation failed',
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }

    const { name, metadata } = parseResult.data;

    // Create the app with VAPID keys
    const app = await createApp(walletAddress, name, metadata);

    logger.info('App registered', {
      appId: app.id,
      walletAddress,
      name,
    });

    const response = NextResponse.json(
      {
        success: true,
        data: {
          id: app.id,
          name: app.name,
          apiKey: app.apiKey,
          vapidPublicKey: app.vapidPublicKey,
          createdAt: app.createdAt.toISOString(),
        },
      },
      { status: 201 }
    );

    // Add CORS headers
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to register app', error);
    return errorResponse(
      'Failed to register app',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}

