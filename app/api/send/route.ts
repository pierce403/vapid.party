import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  authenticateApiKey,
  corsHeaders,
  corsResponse,
  parseJsonBody,
} from '@/lib/api-utils';
import { sendNotifications } from '@/lib/notifications';
import { SendNotificationSchema, ErrorCodes } from '@/lib/types';
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

    // Parse and validate request body
    const body = await parseJsonBody(request);
    if (!body) {
      return errorResponse(
        'Invalid JSON body',
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }

    const parseResult = SendNotificationSchema.safeParse(body);
    if (!parseResult.success) {
      return errorResponse(
        parseResult.error.errors[0]?.message || 'Validation failed',
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }

    // Send notifications
    const result = await sendNotifications(app, parseResult.data);

    logger.info('Notifications sent', {
      appId: app.id,
      sent: result.sent,
      failed: result.failed,
      total: result.total,
    });

    const response = NextResponse.json(
      {
        success: true,
        data: {
          sent: result.sent,
          failed: result.failed,
          total: result.total,
          failures: result.results
            .filter((r) => !r.success)
            .map((r) => ({
              subscriptionId: r.subscriptionId,
              error: r.error,
            })),
        },
      },
      { status: 200 }
    );

    // Add CORS headers
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Rate limit exceeded') {
      return errorResponse(
        'Rate limit exceeded. Please try again later.',
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        429
      );
    }

    logger.error('Failed to send notifications', error);
    return errorResponse(
      'Failed to send notifications',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }
}

