#!/usr/bin/env tsx
/**
 * Database Migration Script
 * 
 * Run with: npm run db:migrate
 * 
 * This script initializes the database schema for vapid.party.
 * It's safe to run multiple times (uses CREATE IF NOT EXISTS).
 */

import { sql } from '@vercel/postgres';

async function migrate() {
  console.log('🚀 Starting database migration...\n');

  try {
    // Apps table with per-app VAPID keys
    console.log('Creating apps table...');
    await sql`
      CREATE TABLE IF NOT EXISTS apps (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_wallet VARCHAR(42) NOT NULL,
        api_key VARCHAR(64) UNIQUE NOT NULL,
        vapid_public_key TEXT NOT NULL,
        vapid_private_key TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        rate_limit JSONB DEFAULT '{"maxNotificationsPerMinute": 60, "maxNotificationsPerDay": 10000, "maxSubscriptions": 10000}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('✓ apps table ready');

    // Index for owner wallet lookups
    console.log('Creating apps indexes...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_apps_owner_wallet ON apps(owner_wallet)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key)
    `;
    console.log('✓ apps indexes ready');

    // Subscriptions table with userId/channelId support
    console.log('Creating subscriptions table...');
    await sql`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY,
        app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_id VARCHAR(255),
        channel_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE(app_id, endpoint)
      )
    `;
    console.log('✓ subscriptions table ready');

    // Indexes for efficient querying
    console.log('Creating subscriptions indexes...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_app_id ON subscriptions(app_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(app_id, user_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_channel_id ON subscriptions(app_id, channel_id)
    `;
    console.log('✓ subscriptions indexes ready');

    // Rate limiting logs
    console.log('Creating rate_limit_logs table...');
    await sql`
      CREATE TABLE IF NOT EXISTS rate_limit_logs (
        id UUID PRIMARY KEY,
        app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        count INTEGER DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL,
        UNIQUE(app_id, action, window_start)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_app_window ON rate_limit_logs(app_id, window_start)
    `;
    console.log('✓ rate_limit_logs table ready');

    // Billing preparation table (for future use)
    console.log('Creating usage_logs table (for future billing)...');
    await sql`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        count INTEGER DEFAULT 1,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_usage_logs_app_date ON usage_logs(app_id, created_at)
    `;
    console.log('✓ usage_logs table ready');

    console.log('\n✅ Database migration completed successfully!');
    console.log('\nTables created:');
    console.log('  • apps - Store app configurations and VAPID keys');
    console.log('  • subscriptions - Store push subscription endpoints');
    console.log('  • rate_limit_logs - Track rate limiting');
    console.log('  • usage_logs - Track usage for billing (future)');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }

  process.exit(0);
}

migrate();

