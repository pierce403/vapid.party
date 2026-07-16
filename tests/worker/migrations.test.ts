import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { migrationStatements } from './migration-helpers';

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
    await applyMigration(
      db,
      await loadMigration('../../migrations/d1/0006_public_apps_and_usage.sql')
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
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name = 'app_credentials') AS credential_table_count,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name = 'app_usage_daily') AS usage_table_count,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_xmtp_identities_app_installation')
          AS installation_index_count,
        (SELECT xmtp_topic_id FROM delivery_attempts WHERE id = 'attempt-1') AS attempt_topic
    `).first()).toEqual({
      identity_count: 1,
      logical_count: 1,
      topic_count: 1,
      hmac_count: 1,
      diagnostic_column_count: 1,
      attempt_registration_column_count: 1,
      credential_table_count: 1,
      usage_table_count: 1,
      installation_index_count: 1,
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

  it('fails 0006 before adding its index when one app maps an installation to two inboxes', async () => {
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
    ]) await applyMigration(db, await loadMigration(path));
    await insertApp(db, 'app-a');
    await db.batch([
      db.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
        VALUES ('identity-a', 'app-a', 'inbox-a', 'installation-shared')
      `),
      db.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
        VALUES ('identity-b', 'app-a', 'inbox-b', 'installation-shared')
      `),
    ]);

    await expect(applyMigration(
      db,
      await loadMigration('../../migrations/d1/0006_public_apps_and_usage.sql')
    )).rejects.toThrow(/xmtp_installation_identity_guard_0006/);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_xmtp_identities_app_installation'
    `).first()).toEqual({ count: 0 });
  });

  it('atomically guards physical and logical subscription limits while allowing refreshes', async () => {
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
      '../../migrations/d1/0006_public_apps_and_usage.sql',
    ]) await applyMigration(db, await loadMigration(path));
    await insertApp(db, 'app-a');
    await db.prepare(`
      UPDATE apps SET rate_limit = '{"maxSubscriptions":1}' WHERE id = 'app-a'
    `).run();

    const attempts = await Promise.allSettled([
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('physical-a', 'app-a', 'https://push.example/a', 'p256dh-a', 'auth-a')
      `).run(),
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('physical-b', 'app-a', 'https://push.example/b', 'p256dh-b', 'auth-b')
      `).run(),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String((attempts.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('app_subscription_limit');

    const physical = await db.prepare(`
      SELECT id, endpoint FROM subscriptions WHERE disabled_at IS NULL
    `).first<{ id: string; endpoint: string }>();
    expect(physical).toBeTruthy();
    await db.prepare(`
      INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
      VALUES ('physical-refresh', 'app-a', ?, 'p256dh-refresh', 'auth-refresh')
      ON CONFLICT(app_id, endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth
    `).bind(physical?.endpoint).run();
    expect(await db.prepare(`
      SELECT p256dh, auth FROM subscriptions WHERE id = ?
    `).bind(physical?.id).first()).toEqual({
      p256dh: 'p256dh-refresh',
      auth: 'auth-refresh',
    });

    await expect(db.prepare(`
      INSERT INTO subscriptions (
        id, app_id, endpoint, p256dh, auth, expires_at
      ) VALUES (
        'physical-expired', 'app-a', 'https://push.example/expired',
        'p256dh-expired', 'auth-expired', '1970-01-01T00:00:00.000Z'
      )
    `).run()).rejects.toThrow(/app_subscription_limit/);

    await db.prepare(`
      INSERT INTO subscriptions (
        id, app_id, endpoint, p256dh, auth, disabled_at
      ) VALUES (
        'physical-disabled', 'app-a', 'https://push.example/disabled',
        'p256dh-disabled', 'auth-disabled', '2026-01-01T00:00:00.000Z'
      )
    `).run();
    await expect(db.prepare(`
      UPDATE subscriptions SET disabled_at = NULL WHERE id = 'physical-disabled'
    `).run()).rejects.toThrow(/app_subscription_limit/);

    await db.batch([
      db.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
        VALUES ('identity-a', 'app-a', 'inbox-a', 'installation-a')
      `),
      db.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
        VALUES ('identity-b', 'app-a', 'inbox-b', 'installation-b')
      `),
    ]);
    await db.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id, active)
      VALUES ('logical-a', 'identity-a', ?, 1)
    `).bind(physical?.id).run();
    await expect(db.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id, active)
      VALUES ('logical-b', 'identity-b', ?, 1)
    `).bind(physical?.id).run()).rejects.toThrow(/app_subscription_limit/);
    await db.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id, active)
      VALUES ('logical-inactive', 'identity-b', ?, 0)
    `).bind(physical?.id).run();
    await expect(db.prepare(`
      UPDATE xmtp_subscriptions SET active = 1 WHERE id = 'logical-inactive'
    `).run()).rejects.toThrow(/app_subscription_limit/);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_subscriptions xs
      JOIN xmtp_identities xi ON xi.id = xs.identity_id
      WHERE xi.app_id = 'app-a' AND xs.active = 1
    `).first()).toEqual({ count: 1 });
  });

  it('keeps XMTP listener capacity counters exact across direct and cascading deletes', async () => {
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
      '../../migrations/d1/0006_public_apps_and_usage.sql',
    ]) await applyMigration(db, await loadMigration(path));
    await insertApp(db, 'app-a');
    await db.prepare(`
      INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
      VALUES ('identity-a', 'app-a', 'inbox-a', 'installation-a')
    `).run();

    const capacity = async () => db.prepare(`
      SELECT
        COALESCE((SELECT row_count FROM xmtp_app_capacity WHERE app_id = 'app-a'), 0)
          AS app_count,
        (SELECT row_count FROM xmtp_global_capacity WHERE id = 1) AS global_count,
        (
          SELECT COUNT(*)
          FROM xmtp_topics xt
          JOIN xmtp_identities xi ON xi.id = xt.identity_id
          WHERE xi.app_id = 'app-a'
        ) + (
          SELECT COUNT(*)
          FROM xmtp_topic_hmac_keys hk
          JOIN xmtp_topics xt ON xt.id = hk.topic_id
          JOIN xmtp_identities xi ON xi.id = xt.identity_id
          WHERE xi.app_id = 'app-a'
        ) AS live_count
    `).first();

    await db.batch([
      db.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic)
        VALUES ('topic-a', 'identity-a', '/xmtp/a')
      `),
      db.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic)
        VALUES ('topic-b', 'identity-a', '/xmtp/b')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-a1', 'topic-a', '1', 'AQ')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-a2', 'topic-a', '2', 'Ag')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-b1', 'topic-b', '1', 'Aw')
      `),
    ]);
    expect(await capacity()).toEqual({ app_count: 5, global_count: 5, live_count: 5 });

    await db.prepare("DELETE FROM xmtp_topic_hmac_keys WHERE id = 'hmac-a2'").run();
    expect(await capacity()).toEqual({ app_count: 4, global_count: 4, live_count: 4 });

    // The production replacement path starts by deleting an identity's topics.
    // Its HMAC children cascade after the parent topic is no longer queryable.
    await db.prepare("DELETE FROM xmtp_topics WHERE id = 'topic-a'").run();
    expect(await capacity()).toEqual({ app_count: 2, global_count: 2, live_count: 2 });

    await db.batch([
      db.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic)
        VALUES ('topic-c', 'identity-a', '/xmtp/c')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-c1', 'topic-c', '1', 'BA')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-c2', 'topic-c', '2', 'BQ')
      `),
    ]);
    expect(await capacity()).toEqual({ app_count: 5, global_count: 5, live_count: 5 });

    await db.prepare("DELETE FROM xmtp_identities WHERE id = 'identity-a'").run();
    expect(await capacity()).toEqual({ app_count: 0, global_count: 0, live_count: 0 });

    await db.batch([
      db.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id)
        VALUES ('identity-b', 'app-a', 'inbox-b', 'installation-b')
      `),
      db.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic)
        VALUES ('topic-d', 'identity-b', '/xmtp/d')
      `),
      db.prepare(`
        INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
        VALUES ('hmac-d1', 'topic-d', '1', 'Bg')
      `),
    ]);
    expect(await capacity()).toEqual({ app_count: 2, global_count: 2, live_count: 2 });
    await db.prepare("DELETE FROM apps WHERE id = 'app-a'").run();
    expect(await db.prepare(
      'SELECT row_count AS global_count FROM xmtp_global_capacity WHERE id = 1'
    ).first()).toEqual({ global_count: 0 });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM xmtp_app_capacity WHERE app_id = 'app-a'"
    ).first()).toEqual({ count: 0 });
  });

  it('keeps anonymous app and subscription capacity exact across refresh and cascade', async () => {
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
      '../../migrations/d1/0006_public_apps_and_usage.sql',
    ]) await applyMigration(db, await loadMigration(path));
    await insertApp(db, 'public-a');
    await db.batch([
      db.prepare(`
        INSERT INTO app_credentials (id, app_id, secret_hash)
        VALUES ('credential-a', 'public-a', 'hash-a')
      `),
      db.prepare(`
        INSERT INTO app_public_profiles (app_id, description)
        VALUES ('public-a', '')
      `),
    ]);
    expect(await db.prepare(`
      SELECT app_count, subscription_count FROM public_platform_capacity WHERE id = 1
    `).first()).toEqual({ app_count: 1, subscription_count: 0 });

    await db.batch([
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('public-sub-a', 'public-a', 'https://push.example/a', 'a', 'a')
      `),
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('public-sub-b', 'public-a', 'https://push.example/b', 'b', 'b')
      `),
    ]);
    await db.prepare(`
      INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
      VALUES ('ignored-refresh-id', 'public-a', 'https://push.example/a', 'new-a', 'new-a')
      ON CONFLICT(app_id, endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth
    `).run();
    expect(await db.prepare(`
      SELECT app_count, subscription_count FROM public_platform_capacity WHERE id = 1
    `).first()).toEqual({ app_count: 1, subscription_count: 2 });

    await db.prepare("DELETE FROM subscriptions WHERE id = 'public-sub-a'").run();
    expect(await db.prepare(`
      SELECT app_count, subscription_count FROM public_platform_capacity WHERE id = 1
    `).first()).toEqual({ app_count: 1, subscription_count: 1 });
    await db.prepare("DELETE FROM apps WHERE id = 'public-a'").run();
    expect(await db.prepare(`
      SELECT app_count, subscription_count FROM public_platform_capacity WHERE id = 1
    `).first()).toEqual({ app_count: 0, subscription_count: 0 });
  });
});
