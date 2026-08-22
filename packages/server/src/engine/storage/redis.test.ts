import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { RedisStorageProvider } from './redis'

// Exercises the real ioredis driver. Skipped unless REDIS_TEST_URL points at a
// throwaway Redis — the suite calls flushAll, so never aim it at real data.
const url = process.env.REDIS_TEST_URL

describe.skipIf(!url)('RedisStorageProvider (integration)', () => {
  const redis = new RedisStorageProvider(url!)

  beforeEach(async () => {
    await redis.flushAll()
  })

  afterAll(async () => {
    await redis.flushAll()
  })

  it('round-trips a value', async () => {
    await redis.set('k', 'v')
    expect(await redis.get('k')).toBe('v')
  })

  it('returns null for a missing key', async () => {
    expect(await redis.get('absent')).toBeNull()
  })

  it('honours a ttl on set', async () => {
    await redis.set('k', 'v', 60)
    expect(await redis.get('k')).toBe('v')
  })

  it('deletes a key', async () => {
    await redis.set('k', 'v')
    await redis.del('k')
    expect(await redis.get('k')).toBeNull()
  })

  it('pushes to both ends of a list and reads it back', async () => {
    await redis.lpush('list', 'a')
    await redis.lpush('list', 'b')
    await redis.rpush('list', 'z')
    expect(await redis.lrange('list', 0, -1)).toEqual(['b', 'a', 'z'])
    expect(await redis.llen('list')).toBe(3)
  })

  it('trims a list to a range', async () => {
    for (const v of ['a', 'b', 'c', 'd']) await redis.rpush('list', v)
    await redis.ltrim('list', 0, 1)
    expect(await redis.lrange('list', 0, -1)).toEqual(['a', 'b'])
  })

  it('expires a key without deleting it immediately', async () => {
    await redis.set('k', 'v')
    await redis.expire('k', 60)
    expect(await redis.get('k')).toBe('v')
  })

  it('clears everything on flushAll', async () => {
    await redis.set('k', 'v')
    await redis.flushAll()
    expect(await redis.get('k')).toBeNull()
  })
})
