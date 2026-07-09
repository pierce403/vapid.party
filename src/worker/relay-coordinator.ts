import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

interface ShardRow {
  owner?: string | number | ArrayBuffer | null;
  lease_expires_at?: string | number | ArrayBuffer | null;
  cursor?: string | number | ArrayBuffer | null;
}

function sqlString(value: string | number | ArrayBuffer | null | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sqlNumber(value: string | number | ArrayBuffer | null | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class RelayCoordinator extends DurableObject<Env> {
  private initialized = false;

  private ensureSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shard_state (
        shard TEXT PRIMARY KEY,
        owner TEXT,
        lease_expires_at INTEGER,
        cursor TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    this.initialized = true;
  }

  async claimShard(
    shard: string,
    owner: string,
    ttlSeconds = 60
  ): Promise<{ claimed: boolean; owner?: string; leaseExpiresAt?: string; cursor?: string }> {
    this.ensureSchema();
    const now = Date.now();
    const leaseExpiresAt = now + ttlSeconds * 1000;
    const existing = this.ctx.storage.sql
      .exec('SELECT owner, lease_expires_at, cursor FROM shard_state WHERE shard = ?', shard)
      .one() as ShardRow | null;
    const existingOwner = sqlString(existing?.owner);
    const existingLease = sqlNumber(existing?.lease_expires_at);
    const existingCursor = sqlString(existing?.cursor);

    if (existingOwner && existingLease && existingLease > now && existingOwner !== owner) {
      return {
        claimed: false,
        owner: existingOwner,
        leaseExpiresAt: new Date(existingLease).toISOString(),
        cursor: existingCursor,
      };
    }

    this.ctx.storage.sql.exec(`
      INSERT INTO shard_state (shard, owner, lease_expires_at, cursor, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shard) DO UPDATE SET
        owner = excluded.owner,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `, shard, owner, leaseExpiresAt, existingCursor ?? null, now);

    return {
      claimed: true,
      owner,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      cursor: existingCursor,
    };
  }

  async saveCursor(
    shard: string,
    owner: string,
    cursor: string
  ): Promise<{ saved: boolean }> {
    this.ensureSchema();
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec('SELECT owner, lease_expires_at FROM shard_state WHERE shard = ?', shard)
      .one() as ShardRow | null;
    const existingOwner = sqlString(existing?.owner);
    const existingLease = sqlNumber(existing?.lease_expires_at);

    if (!existing || existingOwner !== owner || !existingLease || existingLease < now) {
      return { saved: false };
    }

    this.ctx.storage.sql.exec(`
      UPDATE shard_state SET cursor = ?, updated_at = ? WHERE shard = ? AND owner = ?
    `, cursor, now, shard, owner);

    return { saved: true };
  }

  async getCursor(shard: string): Promise<{ cursor?: string; owner?: string; leaseExpiresAt?: string }> {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec('SELECT owner, lease_expires_at, cursor FROM shard_state WHERE shard = ?', shard)
      .one() as ShardRow | null;
    const lease = sqlNumber(row?.lease_expires_at);

    return {
      cursor: sqlString(row?.cursor),
      owner: sqlString(row?.owner),
      leaseExpiresAt: lease ? new Date(lease).toISOString() : undefined,
    };
  }

  async releaseShard(shard: string, owner: string): Promise<{ released: boolean }> {
    this.ensureSchema();
    const result = this.ctx.storage.sql.exec(`
      UPDATE shard_state SET owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE shard = ? AND owner = ?
    `, Date.now(), shard, owner);

    return { released: result.rowsWritten > 0 };
  }
}
