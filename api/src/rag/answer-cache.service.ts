import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import type { AnswerResult } from './answer.service';

/** Prefix for every cache key this service writes/reads, so the keyspace is
 * unambiguous if the same Redis instance is shared with other subsystems
 * (BullMQ queues, the rate limiter, etc). */
const KEY_PREFIX = 'bonsai:ans:';

/** Hard cap on the in-memory fallback store so an unbounded stream of
 * distinct questions cannot leak memory when no Redis is configured
 * (dev/test). Oldest-inserted entries are evicted first once the cap is
 * exceeded. */
const MAX_IN_MEMORY_ENTRIES = 1000;

interface InMemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * Per-project answer cache (A9): caches grounded (non-refused) `AnswerResult`s
 * so an identical repeated question skips the expensive retrieval+LLM
 * pipeline entirely.
 *
 * Cache key = `bonsai:ans:` + sha256(`${projectId}|${kbVersion}|${normalized
 * question}`). Callers derive `kbVersion` from a cheap per-project value that
 * changes whenever the project's knowledge changes (e.g. the max
 * `knowledge_sources.updated_at`), so a knowledge update automatically mints
 * a new key for the same question — no explicit cache purge/invalidation
 * path is needed.
 *
 * Backing store: an ioredis client when `cfg.redisUrl` is configured (shared
 * across replicas), otherwise an in-memory `Map` with lazy per-entry expiry
 * and a size cap, so dev/test without Redis still works.
 */
@Injectable()
export class AnswerCacheService implements OnModuleDestroy {
  private redis?: Redis;
  private readonly memory = new Map<string, InMemoryEntry>();

  constructor(@Optional() @Inject(APP_CONFIG) cfg?: AppConfig) {
    if (cfg?.redisUrl) {
      const u = new URL(cfg.redisUrl);
      this.redis = new Redis({
        host: u.hostname,
        port: Number(u.port) || 6379,
      });
    }
  }

  async get(
    projectId: string,
    kbVersion: string,
    question: string,
  ): Promise<AnswerResult | null> {
    const key = this.buildKey(projectId, kbVersion, question);
    const raw = this.redis ? await this.redis.get(key) : this.getInMemory(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as AnswerResult;
    } catch {
      return null;
    }
  }

  async set(
    projectId: string,
    kbVersion: string,
    question: string,
    result: AnswerResult,
    ttlMs: number,
  ): Promise<void> {
    const key = this.buildKey(projectId, kbVersion, question);
    const raw = JSON.stringify(result);
    if (this.redis) {
      await this.redis.set(key, raw, 'PX', ttlMs);
      return;
    }
    this.setInMemory(key, raw, ttlMs);
  }

  private buildKey(
    projectId: string,
    kbVersion: string,
    question: string,
  ): string {
    const normalized = normalizeQuestion(question);
    const hash = createHash('sha256')
      .update(`${projectId}|${kbVersion}|${normalized}`)
      .digest('hex');
    return `${KEY_PREFIX}${hash}`;
  }

  private getInMemory(key: string): string | null {
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  private setInMemory(key: string, value: string, ttlMs: number): void {
    if (this.memory.size >= MAX_IN_MEMORY_ENTRIES && !this.memory.has(key)) {
      // Map preserves insertion order; the first key is the oldest entry.
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey !== undefined) this.memory.delete(oldestKey);
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }
}

/** trim + collapse internal whitespace + lowercase, so trivially-different
 * phrasings of the same question ("  Wat  zijn?" vs "wat zijn?") hit the same
 * cache entry. */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}
