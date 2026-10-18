import { afterEach, expect, it, vi } from 'vitest';
import { isReadQuotaError, nextQuotaReset, QueryCache } from './cache';
import type { Database } from './db';
import { memoryCache } from './test-cache';
const db=()=>({prepare(){throw new Error('unexpected SQL');}}) as Database;
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('recognizes nested D1 row-read quota errors without confusing generic errors or other limits',()=>{
  expect(isReadQuotaError(new Error('D1_ERROR',{cause:new Error("Your account has exceeded D1's free tier daily row read limit.")}))).toBe(true);
  expect(isReadQuotaError(new Error('D1 daily row write limit'))).toBe(false);
  expect(isReadQuotaError(new Error('SQL syntax error'))).toBe(false);
  expect(nextQuotaReset(Date.parse('2026-10-18T23:59:59Z'))).toBe(Date.parse('2026-10-19T00:00:00Z'));
});
it('caches successful reads per query, expires them, and never caches failures',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  const cache=new QueryCache(db(),'https://test',memoryCache()),load=vi.fn(async()=>({value:1}));
  expect((await cache.read('one',15,load)).hit).toBe(false);
  expect((await cache.read('one',15,load)).hit).toBe(true);expect(load).toHaveBeenCalledTimes(1);
  await cache.read('two',15,load);expect(load).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(15000);expect((await cache.read('one',15,load)).hit).toBe(false);
  const fail=vi.fn(async()=>{throw new Error('database failure');});
  await expect(cache.read('bad',15,fail)).rejects.toThrow();await expect(cache.read('bad',15,fail)).rejects.toThrow();
  expect(fail).toHaveBeenCalledTimes(2);
});
it('circuits quota failures until midnight UTC, across instances, and still allows successful cached reads',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T23:59:50Z'));
  const shared=memoryCache(),database=db(),cache=new QueryCache(database,'https://test',shared);
  await cache.read('ready',300,async()=>1);await cache.markQuotaExceeded();
  expect((await cache.read('ready',300,async()=>2)).body).toBe(1);
  await expect(new QueryCache(db(),'https://test',shared).assertQuotaAvailable()).rejects.toThrow('D1_READ_QUOTA_EXCEEDED');
  await expect(new QueryCache(database,'https://test').assertQuotaAvailable()).rejects.toThrow('D1_READ_QUOTA_EXCEEDED');
  vi.advanceTimersByTime(10000);await expect(cache.assertQuotaAvailable()).resolves.toBeUndefined();
});
it('cache infrastructure failure does not take down healthy database reads or quota reporting',async()=>{
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  const broken={match:async()=>{throw new Error('unavailable');},put:async()=>{throw new Error('unavailable');}} as unknown as Cache;
  const cache=new QueryCache(db(),'https://test',broken);
  expect((await cache.read('a',30,async()=>5)).body).toBe(5);
  await cache.markQuotaExceeded();await expect(cache.assertQuotaAvailable()).rejects.toThrow('D1_READ_QUOTA_EXCEEDED');
});
