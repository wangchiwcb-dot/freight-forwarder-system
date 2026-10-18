import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { fixture } from './test-db';
import { DEFAULT_CRITERIA, searchQuotes } from '../src/domain/search';
import { getQuotes } from './repository';
import type { SearchCriteria, SearchResponse } from '../src/domain/types';

let f: ReturnType<typeof fixture>;
beforeEach(() => { f=fixture(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T04:00:00Z')); });
afterEach(() => { f.sqlite.close(); vi.useRealTimers(); });
const criteria = (patch: Partial<SearchCriteria> = {}) => ({ ...DEFAULT_CRITERIA, asOf:'2026-10-18', ...patch });
const call = (path: string, options?: RequestInit) => worker.fetch(new Request(`https://test/api${path}`,options),{ DB:f.db });
const post = (data: unknown, headers = {'Content-Type':'application/json'}) => call('/quotes/search',{method:'POST',headers,body:JSON.stringify(data)});
async function query(patch: Partial<SearchCriteria> = {}, extra = {}) {
  const response = await post({ criteria:criteria(patch),...extra });
  const body = await response.json() as SearchResponse;
  expect(response.status,JSON.stringify(body)).toBe(200);
  return body;
}
describe('database HTTP API',() => {
  it('serves a database catalog and source coverage without private paths',async() => {
    const response = await call('/catalog'); const data = await response.json() as any;
    expect(data.snapshotId).toBe('current'); expect(data.snapshots).toHaveLength(2);
    expect(data.stats.quotes).toBe(12); expect(data.files).toHaveLength(12);
    expect(JSON.stringify(data)).not.toContain('PRIVATE_PATH');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await call('/sources')).status).toBe(200);
  });
  it('paginates globally ranked costs, preserving unknown, conditional and expired states',async() => {
    const first = await query({actualKg:500,volumeCbm:1,pieces:1},{pageSize:2});
    expect(first.items.map(r=>r.quote.id)).toEqual(['fee','cbm']);
    expect(first.items.map(r=>r.estimatedCost)).toEqual([50.2,600]);
    expect(first.total).toBe(9); expect(first.computedCount).toBe(3); expect(first.pendingCount).toBe(6);
    const second=await query({actualKg:500,volumeCbm:1,pieces:1},{page:2,pageSize:2});
    expect(second.items[0].quote.id).toBe('kg');
    const allowed=await query({actualKg:500,volumeCbm:1,pieces:1,includePending:false});
    expect(allowed.items.map(r=>r.quote.id)).toEqual(['fee','cbm','kg']);
    expect((await query({}, {page:999})).items).toEqual([]);
  });
  it('keeps source snapshots separate and returns scoped history with tier evidence',async() => {
    const data=await query({}, {snapshotId:'historical'}); expect(data.items.map(r=>r.quote.id)).toEqual(['old']);
    const history=await (await call('/quotes/kg/history')).json() as any;
    expect(history.items.map((r:any)=>r.id)).toEqual(['kg','old']);
    expect(history.items[1].tiers[0].price).toBe(8);
    const detail=await (await call('/quotes/kg')).json() as any;
    expect(detail.tax.evidenceKind).toBe('business_default'); expect(detail.source.cells).toEqual(['B2']);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_PATH');
    for (const id of ['staged','archived','revoked','missing']) expect((await call(`/quotes/${id}`)).status).toBe(404);
  });
  it('preserves leading zero postal prefixes and keeps EU out of GB',async() => {
    const hit=await query({destination:'09001'}); expect(hit.items.some(r=>r.quote.id==='kg')).toBe(true);
    expect((await query({destination:'90001'})).total).toBe(0);
    expect((await query({destination:"' OR 1=1 --"})).total).toBe(0);
    expect((await query({country:'GB'})).items.map(r=>r.quote.id)).toEqual(['gb']);
    expect((await query({country:'DE',includePending:false})).total).toBe(0);
  });
  it('counts a confirmed per-piece fixed fee per piece, and refuses missing quantities',async()=>{
    f.add('piecefee',{basis:'parcel',price:10,fixed:2});
    f.sqlite.prepare("UPDATE quote_charge_rules SET charge_basis='piece' WHERE quote_version_id='piecefee'").run();
    const data=await query({pieces:3});
    expect(data.items.find(r=>r.quote.id==='piecefee')?.estimatedCost).toBe(36);
    f.add('volume_piecefee',{basis:'cbm',price:10,fixed:2});
    f.sqlite.prepare("UPDATE quote_charge_rules SET charge_basis='piece' WHERE quote_version_id='volume_piecefee'").run();
    const missing=await query({volumeCbm:1},{pageSize:100});
    expect(missing.items.find(r=>r.quote.id==='volume_piecefee')?.eligible).toBe(false);
  });
  it('rejects invalid input, malformed bodies, methods, duplicates and oversized chunked bodies',async() => {
    for (const patch of [{actualKg:-1},{volumeCbm:0},{pieces:1.5},{asOf:'2026-02-30'},{country:'XX'},{onlyOwn:'false'}])
      expect((await post({criteria:{...criteria(),...patch}})).status).toBe(400);
    for (const extra of [{page:0},{pageSize:101},{page:'1'},{unused:true}]) expect((await post({criteria:criteria(),...extra})).status).toBe(400);
    expect((await call('/quotes/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status).toBe(400);
    expect((await post({criteria:criteria()},{'Content-Type':'text/plain'})).status).toBe(415);
    expect((await post({padding:'a'.repeat(17000)})).status).toBe(413);
    expect((await call('/catalog?snapshotId=current&snapshotId=historical')).status).toBe(400);
    expect((await call('/catalog?unknown=1')).status).toBe(400);
    expect((await call('/catalog?snapshotId=missing')).status).toBe(404);
    expect((await call('/quotes/search')).status).toBe(405);
    expect((await call('/upload',{method:'POST'})).status).toBe(404);
    expect((await call('/quotes/kg',{method:'DELETE'})).status).toBe(405);
  });
  it('restricts browser CORS to the existing Pages origin and hides database failures',async() => {
    const allowed=await call('/catalog',{headers:{Origin:'https://wangchiwcb-dot.github.io'}});
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://wangchiwcb-dot.github.io');
    const blocked=await call('/catalog',{headers:{Origin:'https://unrelated.example'}});
    expect(blocked.headers.has('access-control-allow-origin')).toBe(false);
    const options=await call('/quotes/search',{method:'OPTIONS',headers:{Origin:'https://wangchiwcb-dot.github.io'}});
    expect(options.status).toBe(204);
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
    const response=await worker.fetch(new Request('https://test/api/health'),{DB:{prepare(){throw new Error('SECRET SQL');}}});
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('SECRET SQL'); spy.mockRestore();
  });
  it('matches the shared decimal calculator across quantity, sorting, time and eligibility boundaries',async() => {
    f.add('density',{basis:'cbm',rules:{maxKgPerCbm:500}});
    f.add('timed',{from:'2026-10-18T13:00:00+08:00'});
    f.add('filename',{date:'2026-11-01',dateKind:'filename'});
    const ids=(f.sqlite.prepare(`SELECT v.id FROM quote_versions v JOIN import_batches b ON b.id=v.batch_id
      JOIN snapshot_batches sb ON sb.batch_id=b.id WHERE b.status='published' AND sb.snapshot_id='current' ORDER BY v.id`).all() as {id:string}[]).map(r=>r.id);
    const all=await getQuotes(f.db,ids);
    for (const actualKg of [null,0.1,100,500,1000]) for (const sort of ['cost','unit','updated','reliability'] as const) {
      const c=criteria({actualKg,volumeCbm:1,pieces:1,sort});
      const expected=searchQuotes(all,c); const actual=await query(c,{pageSize:100});
      expect(actual.total).toBe(expected.length);
      expect(actual.items.map(r=>[r.quote.id,r.estimatedCost,r.eligible])).toEqual(expected.map(r=>[r.quote.id,r.estimatedCost,r.eligible]));
    }
  });
});
