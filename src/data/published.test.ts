import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { PublishedRepository } from './published';
import { DEFAULT_CRITERIA } from '../domain/search';

const read=async(path:string)=>JSON.parse(readFileSync(`public/published/${path}`,'utf8'));
it('validates every published partition, its coverage and lookup; excludes private database fields',async()=>{
  const reader=vi.fn(read),repo=new PublishedRepository(reader),m=await repo.getManifest();
  const ids=new Set<string>();
  for(const id of m.snapshots){
    const catalog=await repo.catalog(id);
    const result=await repo.search({criteria:{...DEFAULT_CRITERIA,country:'ALL',asOf:'2026-10-18'},snapshotId:id,page:1,pageSize:100});
    expect(result.provenance?.version).toBe(m.version);expect(result.total).toBeGreaterThan(0);
    let count=0;
    for(const chunk of catalog.chunks){
      const body=await read(`${m.version}/${chunk.path}`);expect(body.quotes).toHaveLength(chunk.count);count+=body.quotes.length;
      for(const q of body.quotes){ids.add(q.id);const text=JSON.stringify(q);
        expect(text).not.toMatch(/"(?:local_path|source_quote_json|raw_json|audit_log|password)"/);
      }
    }
    expect(count).toBe(catalog.stats.quotes);
  }
  expect(ids.size).toBe(m.quotes);
  const criteria={...DEFAULT_CRITERIA,actualKg:300,volumeCbm:1,pieces:10,asOf:'2026-10-18'};
  const first=await repo.search({criteria,page:1,pageSize:15}),reads=reader.mock.calls.filter(([p])=>p.includes('/quotes-')).length;
  const second=await repo.search({criteria,page:2,pageSize:15});
  expect(second.total).toBe(first.total);expect(first.computedCount).toBeGreaterThan(0);
  expect(second.items.every(r=>first.items.every(q=>q.quote.id!==r.quote.id))).toBe(true);
  expect(reader.mock.calls.filter(([p])=>p.includes('/quotes-'))).toHaveLength(reads);
  expect(await repo.quote(first.items[0].quote.id)).toEqual(first.items[0].quote);
  expect((await repo.history(first.items[0].quote.id,1,5)).items[0].snapshots.length).toBeGreaterThan(0);
},60000);
it('rejects malformed manifests, mixed catalog versions, invalid paths and missing rule references',async()=>{
  await expect(new PublishedRepository(async()=>({version:'../secret'})).getManifest()).rejects.toThrow();
  const mismatch=new PublishedRepository(async path=>{const value=await read(path);if(path.includes('catalog-'))value.provenance.version='another-version';return value;});
  await expect(mismatch.catalog()).rejects.toThrow('发布快照版本不一致');
  const missingRules=new PublishedRepository(async path=>{const value=await read(path);if(path.includes('/quotes-'))value.notes={};return value;});
  await expect(missingRules.search({criteria:DEFAULT_CRITERIA,page:1,pageSize:15})).rejects.toThrow('快照规则缺失');
  const traversal=new PublishedRepository(async path=>{const value=await read(path);if(path.includes('catalog-'))value.chunks[0].path='../secret';return value;});
  await expect(traversal.search({criteria:{...DEFAULT_CRITERIA,country:'ALL'},page:1,pageSize:15})).rejects.toThrow('快照分片路径无效');
  await expect(mismatch.quote('../secret')).rejects.toThrow('快照报价不存在');
});
