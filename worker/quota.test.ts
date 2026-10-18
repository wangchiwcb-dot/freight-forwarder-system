import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import worker from './index';
import { fixture } from './test-db';
import { DEFAULT_CRITERIA } from '../src/domain/search';
import { memoryCache } from './test-cache';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const exhausted=()=>({prepare:vi.fn(()=>{throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. [7500]");})});
const assets={async fetch(request:Request){try{return Response.json(JSON.parse(readFileSync(`public${new URL(request.url).pathname}`,'utf8')));}catch{return new Response(null,{status:404});}}};
const request=(path:string,init?:RequestInit)=>new Request(`https://test/api${path}`,init);
it('health checks real table access and returns a precise retry time; repeated failures avoid D1',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  const DB=exhausted();
  const response=await worker.fetch(request('/health'),{DB});
  expect(response.status).toBe(503);expect(response.headers.get('Retry-After')).toBe('43200');
  expect((await response.json() as any).error).toMatchObject({code:'D1_READ_QUOTA_EXCEEDED',retryAt:'2026-10-19T00:00:00.000Z'});
  await worker.fetch(request('/health'),{DB});expect(DB.prepare).toHaveBeenCalledTimes(1);
  expect(DB.prepare).toHaveBeenCalledWith('SELECT id FROM providers LIMIT 1');
});
it('quota mode serves only a validated, explicitly marked catalog and sources; live search stays explicit',async()=>{
  const DB=exhausted(),env={DB,ASSETS:assets};
  const catalogResponse=await worker.fetch(request('/catalog'),env),catalog=await catalogResponse.json() as any;
  expect(catalogResponse.status).toBe(200);expect(catalogResponse.headers.get('X-Data-Source')).toBe('published-snapshot');
  expect(catalog.provenance.source).toBe('published-snapshot');expect(catalog.stats.quotes).toBe(19319);
  const sources=await (await worker.fetch(request('/sources'),env)).json() as any;
  expect(sources.items).toEqual(catalog.files);expect(sources.provenance).toEqual(catalog.provenance);
  expect((await worker.fetch(request('/catalog?snapshotId=missing'),env)).status).toBe(404);
  const response=await worker.fetch(request('/quotes/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({criteria:DEFAULT_CRITERIA})}),env);
  expect(response.status).toBe(503);expect((await response.json() as any).error.code).toBe('D1_READ_QUOTA_EXCEEDED');
  expect(DB.prepare).toHaveBeenCalledTimes(1);
  expect((await worker.fetch(request('/catalog?unused=yes'),env)).status).toBe(400);
});
it('generic failures and corrupt snapshot assets do not silently become successful fallback responses',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  expect((await worker.fetch(request('/catalog'),{DB:{prepare(){throw new Error('unexpected');}},ASSETS:assets})).status).toBe(503);
  expect((await worker.fetch(request('/catalog'),{DB:exhausted(),ASSETS:{async fetch(){return Response.json({version:'../invalid'});}}})).status).toBe(503);
});
it('shares catalog cache with sources and re-evaluates today at exact expiry boundaries',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T04:00:00Z'));
  const f=fixture(),env={DB:f.db,REQUEST_CACHE:memoryCache()};
  try{
    const prepare=vi.spyOn(f.db,'prepare');
    await worker.fetch(request('/catalog'),env);const calls=prepare.mock.calls.length;
    expect((await worker.fetch(request('/sources'),env)).headers.get('X-Data-Cache')).toBe('HIT');expect(prepare).toHaveBeenCalledTimes(calls);
    f.add('exact-expiry',{to:'2026-10-18T12:00:01+08:00'});
    const query=()=>worker.fetch(request('/quotes/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({criteria:{...DEFAULT_CRITERIA,asOf:'2026-10-18'},pageSize:100})}),env);
    const before=await (await query()).json() as any;
    expect(before.items.find((r:any)=>r.quote.id==='exact-expiry').eligible).toBe(true);
    vi.advanceTimersByTime(1000);
    const after=await (await query()).json() as any;expect(after.items.find((r:any)=>r.quote.id==='exact-expiry').eligible).toBe(false);
  }finally{f.sqlite.close();}
});
