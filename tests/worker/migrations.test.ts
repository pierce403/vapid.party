import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';

function migrationStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  const statements = migrationStatements(sql);
  for (const [index, statement] of statements.entries()) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      throw new Error(`Migration statement ${index + 1} failed: ${statement.slice(0, 120)}`, {
        cause: error,
      });
    }
  }
}

async function loadMigration(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

async function insertApp(db: D1Database, id: string): Promise<void> {
  await db.prepare(`
    INSERT INTO apps (
      id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, id, id, `key-${id}`, `public-${id}`, `private-${id}`).run();
}

describe('XMTP listener expand/contract migrations', () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-14',
      d1Databases: { DB: 'migration-test-db' },
    });
    db = await miniflare.getD1Database('DB');
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('keeps the old Worker writable after 0003, then preserves data through 0004', async () => {
    await applyMigration(db, await loadMigration('../../migrations/d1/0001_cloudflare_relay.sql'));
    await insertApp(db, 'converge');
    await db.batch([
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('subscription-1', 'converge', 'https://push.example/one', 'p256dh', 'auth')
      `),
      db.prepare(`
        INSERT INTO xmtp_identities (id, inbox_id, installation_id, address)
        VALUES ('identity-1', 'inbox-1', 'installation-1', '0xabc')
      `),
      db.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic, hmac_key)
        VALUES ('topic-1', 'identity-1', '/xmtp/mls/1/g-one/proto', 'AQID')
      `),
    ]);
    await db.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id)
      VALUES ('logical-1', 'identity-1', 'subscription-1')
    `).run();
    await db.prepare(`
      INSERT INTO delivery_attempts (
        id, app_id, subscription_id, xmtp_topic_id, event_type, payload_json
      ) VALUES (
        'attempt-1', 'converge', 'subscription-1', 'topic-1', 'xmtp.new_message', '{}'
      )
    `).run();

    await applyMigration(db, await loadMigration('../../migrations/d1/0002_converge_push_contract.sql'));
    await applyMigration(db, await loadMigration('../../migrations/d1/0003_xmtp_listener_registry_expand.sql'));

    // This is the exact identity conflict target used by the previously
    // deployed Worker. It must remain valid between 0003 and the code deploy.
    await db.prepare(`
      INSERT INTO xmtp_identities (
        id, inbox_id, installation_id, address, inbox_handle, created_at, updated_at
      ) VALUES (
        'old-worker-replacement', 'inbox-1', 'installation-1', '0xdef',
        'opaque-handle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
      ON CONFLICT(inbox_id, installation_id) DO UPDATE SET
        address = excluded.address,
        inbox_handle = COALESCE(excluded.inbox_handle, xmtp_identities.inbox_handle),
        updated_at = excluded.updated_at
    `).run();

    expect(await db.prepare(`
      SELECT id, app_id, address, inbox_handle
      FROM xmtp_identities
      WHERE inbox_id = 'inbox-1' AND installation_id = 'installation-1'
    `).first()).toEqual({
      id: 'identity-1',
      app_id: 'converge',
      address: '0xdef',
      inbox_handle: 'opaque-handle',
    });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_listener_changes
      WHERE app_id = 'converge' AND installation_id = 'installation-1'
    `).first()).toEqual({ count: 1 });

    const mismatch = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_subscriptions xs
      JOIN xmtp_identities xi ON xi.id = xs.identity_id
      JOIN subscriptions s ON s.id = xs.subscription_id
      WHERE s.app_id <> xi.app_id
    `).first<{ count: number }>();
    expect(mismatch?.count).toBe(0);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    await applyMigration(
      db,
      await loadMigration('../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql')
    );
    await applyMigration(
      db,
      await loadMigration('../../migrations/d1/0005_xmtp_diagnostics.sql')
    );
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM xmtp_identities) AS identity_count,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical_count,
        (SELECT COUNT(*) FROM xmtp_topics) AS topic_count,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmac_count,
        (SELECT COUNT(*) FROM pragma_table_info('xmtp_subscriptions')
          WHERE name = 'diagnostic_token_hash') AS diagnostic_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('delivery_attempts')
          WHERE name = 'xmtp_subscription_id') AS attempt_registration_column_count,
        (SELECT xmtp_topic_id FROM delivery_attempts WHERE id = 'attempt-1') AS attempt_topic
    `).first()).toEqual({
      identity_count: 1,
      logical_count: 1,
      topic_count: 1,
      hmac_count: 1,
      diagnostic_column_count: 1,
      attempt_registration_column_count: 1,
      attempt_topic: 'topic-1',
    });

    await insertApp(db, 'app-b');
    await db.prepare(`
      INSERT INTO xmtp_identities (
        id, app_id, inbox_id, installation_id, address, inbox_handle
      ) VALUES (
        'identity-app-b', 'app-b', 'inbox-1', 'installation-1', '0xbeef', 'app-b-handle'
      )
      ON CONFLICT DO UPDATE SET address = excluded.address
    `).run();
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_identities
      WHERE inbox_id = 'inbox-1' AND installation_id = 'installation-1'
    `).first()).toEqual({ count: 2 });
  });

  it('fails the 0004 contract before rebuilding when app ownership is inconsistent', async () => {
    await applyMigration(db, await loadMigration('../../migrations/d1/0001_cloudflare_relay.sql'));
    await applyMigration(db, await loadMigration('../../migrations/d1/0002_converge_push_contract.sql'));
    await applyMigration(db, await loadMigration('../../migrations/d1/0003_xmtp_listener_registry_expand.sql'));
    await insertApp(db, 'converge');
    await insertApp(db, 'app-b');
    await db.prepare(`
      INSERT INTO xmtp_identities (
        id, app_id, inbox_id, installation_id, inbox_handle
      ) VALUES ('identity-1', 'converge', 'inbox-1', 'installation-1', 'opaque-handle')
    `).run();
    await db.prepare(`
      INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
      VALUES ('subscription-1', 'app-b', 'https://push.example/one', 'p256dh', 'auth')
    `).run();
    await db.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id)
      VALUES ('logical-1', 'identity-1', 'subscription-1')
    `).run();

    await expect(applyMigration(
      db,
      await loadMigration('../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql')
    )).rejects.toThrow(/xmtp_app_scope_guard_0004/);

    const schema = await db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'xmtp_identities'
    `).first<{ sql: string }>();
    expect(schema?.sql).toContain('UNIQUE(inbox_id, installation_id)');
    expect(schema?.sql).not.toMatch(/UNIQUE\s*\(\s*app_id\s*,/i);
  });
});
