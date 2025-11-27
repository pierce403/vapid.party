import { NextRequest, NextResponse } from 'next/server';
import {
  errorResponse,
  verifyWalletAuth,
  verifyAppOwnership,
  corsHeaders,
  corsResponse,
  parseJsonBody,
} from '@/lib/api-utils';
import { getAppById, updateApp, deleteApp, regenerateApiKey } from '@/lib/db';
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

// Get a specific app
export async function GET(request: NextRequest, { params }: RouteParams) {
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

    const app = await getAppById(id);
    if (!app) {
      return errorResponse('App not found', ErrorCodes.NOT_FOUND, 404);
    }

    const response = NextResponse.json(
      {
        success: true,
        data: {
          id: app.id,
          name: app.name,
          apiKey: app.apiKey,
          vapidPublicKey: app.vapidPublicKey,
          metadata: app.metadata,
          rateLimit: app.rateLimit,
          createdAt: app.createdAt.toISOString(),
          updatedAt: app.updatedAt.toISOString(),
        },
      },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to get app', error);
    return errorResponse('Failed to get app', ErrorCodes.INTERNAL_ERROR, 500);
  }
}

// Update an app
export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const body = await parseJsonBody<{
      name?: string;
      metadata?: { description?: string; website?: string; iconUrl?: string };
    }>(request);

    if (!body) {
      return errorResponse('Invalid JSON body', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const app = await updateApp(id, body);
    if (!app) {
      return errorResponse('App not found', ErrorCodes.NOT_FOUND, 404);
    }

    const response = NextResponse.json(
      {
        success: true,
        data: {
          id: app.id,
          name: app.name,
          metadata: app.metadata,
          updatedAt: app.updatedAt.toISOString(),
        },
      },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to update app', error);
    return errorResponse('Failed to update app', ErrorCodes.INTERNAL_ERROR, 500);
  }
}

// Delete an app
export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    const deleted = await deleteApp(id);
    if (!deleted) {
      return errorResponse('App not found', ErrorCodes.NOT_FOUND, 404);
    }

    logger.info('App deleted', { appId: id, walletAddress });

    const response = NextResponse.json(
      { success: true, data: { deleted: true } },
      { status: 200 }
    );

    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error('Failed to delete app', error);
    return errorResponse('Failed to delete app', ErrorCodes.INTERNAL_ERROR, 500);
  }
}

