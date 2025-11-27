import { NextRequest, NextResponse } from 'next/server';
import { getAppByApiKey, getAppsByOwner } from './db';
import type { App, ApiResponse, ErrorCode } from './types';
import { ErrorCodes } from './types';
import logger, { logApiRequest, logAuthFailure } from './logger';

// ============================================================================
// Response Helpers
// ============================================================================

export function jsonResponse<T>(
  data: T,
  status: number = 200
): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ success: true, data }, { status });
}

export function errorResponse(
  error: string,
  code: ErrorCode,
  status: number
): NextResponse<ApiResponse> {
  return NextResponse.json({ success: false, error, code }, { status });
}

// ============================================================================
// Authentication
// ============================================================================

export interface AuthContext {
  app?: App;
  walletAddress?: string;
}

// Authenticate via API Key (X-API-Key header)
export async function authenticateApiKey(
  request: NextRequest
): Promise<{ app: App } | { error: NextResponse }> {
  const apiKey = request.headers.get('x-api-key');
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  if (!apiKey) {
    logAuthFailure('Missing API key', ip);
    return {
      error: errorResponse(
        'Missing X-API-Key header',
        ErrorCodes.UNAUTHORIZED,
        401
      ),
    };
  }

  const app = await getAppByApiKey(apiKey);

  if (!app) {
    logAuthFailure('Invalid API key', ip);
    return {
      error: errorResponse('Invalid API key', ErrorCodes.INVALID_API_KEY, 401),
    };
  }

  logApiRequest(
    request.method,
    request.nextUrl.pathname,
    ip,
    app.id
  );

  return { app };
}

// Verify wallet signature using thirdweb
export async function verifyWalletAuth(
  request: NextRequest
): Promise<{ walletAddress: string } | { error: NextResponse }> {
  const authHeader = request.headers.get('authorization');
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  if (!authHeader?.startsWith('Bearer ')) {
    logAuthFailure('Missing Authorization header', ip);
    return {
      error: errorResponse(
        'Missing Authorization header',
        ErrorCodes.UNAUTHORIZED,
        401
      ),
    };
  }

  const token = authHeader.slice(7);

  try {
    // Decode and verify the JWT token
    // The token is a base64-encoded JSON containing the wallet address and signature
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      logAuthFailure('Token expired', ip);
      return {
        error: errorResponse('Token expired', ErrorCodes.UNAUTHORIZED, 401),
      };
    }

    const walletAddress = payload.sub || payload.address;
    
    if (!walletAddress) {
      logAuthFailure('Invalid token payload', ip);
      return {
        error: errorResponse('Invalid token', ErrorCodes.UNAUTHORIZED, 401),
      };
    }

    logApiRequest(
      request.method,
      request.nextUrl.pathname,
      ip,
      undefined
    );

    return { walletAddress: walletAddress.toLowerCase() };
  } catch (error) {
    logger.error('Token verification failed', error);
    logAuthFailure('Token verification failed', ip);
    return {
      error: errorResponse('Invalid token', ErrorCodes.UNAUTHORIZED, 401),
    };
  }
}

// Check if wallet owns an app
export async function verifyAppOwnership(
  walletAddress: string,
  appId: string
): Promise<boolean> {
  const apps = await getAppsByOwner(walletAddress);
  return apps.some((app) => app.id === appId);
}

// ============================================================================
// Rate Limiting Headers
// ============================================================================

export function addRateLimitHeaders(
  response: NextResponse,
  limit: number,
  remaining: number,
  reset: Date
): NextResponse {
  response.headers.set('X-RateLimit-Limit', limit.toString());
  response.headers.set('X-RateLimit-Remaining', remaining.toString());
  response.headers.set('X-RateLimit-Reset', reset.toISOString());
  return response;
}

// ============================================================================
// Request Parsing
// ============================================================================

export async function parseJsonBody<T>(
  request: NextRequest
): Promise<T | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// CORS Headers for public endpoints
export function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  };
}

export function corsResponse(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

