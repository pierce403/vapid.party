import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  authenticateApiKey,
  corsHeaders,
  corsResponse,
  parseJsonBody,
  zodValidationErrorResponse,
} from '@/lib/api-utils';
import { createSubscription, countSubscriptionsByApp } from '@/lib/db';
import { SubscribeSchema, ErrorCodes } from '@/lib/types';
import logger from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsResponse();
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate via API key
    const authResult = await authenticateApiKey(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { app } = authResult;

    // Check subscription limit
    const subscriptionCount = await countSubscriptionsByApp(app.id);
    if (subscriptionCount >= app.rateLimit.maxSubscriptions) {
      return errorResponse(
        `Maximum ${app.rateLimit.maxSubscriptions} subscriptions per app allowed`,
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

    const parseResult = SubscribeSchema.safeParse(body);
    if (!parseResult.success) {
      return zodValidationErrorResponse(parseResult.error, body, 422);
    }

    const { endpoint, keys, userId, channelId, metadata, expirationTime } =
      parseResult.data;

    // Create/update subscription
    const subscription = await createSubscription(
      app.id,
      endpoint,
      keys.p256dh,
      keys.auth,
      {
        userId,
        channelId,
        metadata,
        expirationTime,
      }
    );

    logger.info('Subscription created', {
      subscriptionId: subscription.id,
      appId: app.id,
      userId,
      channelId,
    });

    const response = NextResponse.json(
      {
        success: true,
        data: {
          id: subscription.id,
          endpoint: subscription.endpoint,
          createdAt: subscription.createdAt.toISOString(),
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
    logger.error('Failed to create subscription', error);
    return errorResponse(
      'Failed to create subscription',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}
