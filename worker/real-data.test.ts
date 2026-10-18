import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { adapter } from './test-db';
import { getCatalog, getQuotes, joins, visible } from './repository';
import { search } from './search';
import { DEFAULT_CRITERIA, searchQuotes } from '../src/domain/search';
import type { Quote, SearchCriteria } from '../src/domain/types';

const path='.local/d1-import/freight-quotes.sqlite';
it.runIf(existsSync(path))('reconciles API filtering, counts, global ordering and calculations with the verified production dataset',async()=>{
  const sqlite=new DatabaseSync(path,{readOnly:true}); const db=adapter(sqlite);
  try {
    const catalog=await getCatalog(db); expect(catalog.stats.quotes).toBeGreaterThan(19000);
    const ids=(sqlite.prepare(`SELECT v.id ${joins} JOIN snapshot_batches sb ON sb.batch_id=b.id
      WHERE ${visible} AND sb.snapshot_id=? ORDER BY v.id`).all(catalog.snapshotId!) as {id:string}[]).map(row=>row.id);
    const all:Quote[]=[];
    for(let i=0;i<ids.length;i+=100) all.push(...await getQuotes(db,ids.slice(i,i+100)));
    const cases:Partial<SearchCriteria>[]=[{},
      {actualKg:300,volumeCbm:1,pieces:10},
      {actualKg:300,volumeCbm:1,pieces:1,destination:'ONT8',onlyOwn:true},
      {actualKg:1000,volumeCbm:1,pieces:10,destination:'ONT8',sort:'unit'},
      {country:'CA',actualKg:100,volumeCbm:0.1,pieces:1,sort:'updated'},
      {country:'GB',actualKg:10,volumeCbm:0.03,pieces:1,cargo:'battery'},
      {country:'DE',actualKg:100,volumeCbm:1,pieces:10,includePending:false},
      {country:'ALL',sort:'reliability'},
      {origin:'深圳',delivery:'amazon',includePending:false},
      {destination:'09001',actualKg:20,volumeCbm:0.02,pieces:1},
      {cargoShape:'bulky',actualKg:10,volumeCbm:1,pieces:1},
    ];
    for(const patch of cases){
      const criteria={...DEFAULT_CRITERIA,asOf:'2026-10-18',...patch};
      const expected=searchQuotes(all,criteria);
      const start=performance.now();
      const actual=await search(db,{criteria,snapshotId:catalog.snapshotId,page:1,pageSize:15});
      console.log(JSON.stringify({criteria:patch,total:actual.total,computed:actual.computedCount,ms:Math.round(performance.now()-start)}));
      expect(actual.total,JSON.stringify(patch)).toBe(expected.length);
      expect(actual.computedCount).toBe(expected.filter(r=>r.estimatedCost!==null).length);
      expect(actual.pendingCount).toBe(expected.filter(r=>!r.eligible).length);
      expect(actual.items.map(r=>[r.quote.id,r.estimatedCost,r.eligible])).toEqual(expected.slice(0,15).map(r=>[r.quote.id,r.estimatedCost,r.eligible]));
    }
    for(const snapshot of catalog.snapshots!){
      const c=await getCatalog(db,snapshot.id);
      const expected=sqlite.prepare(`SELECT count(*) total ${joins} JOIN snapshot_batches sb ON sb.batch_id=b.id
        WHERE ${visible} AND sb.snapshot_id=?`).get(snapshot.id) as {total:number};
      expect(c.stats.quotes).toBe(expected.total);
    }
  } finally { sqlite.close(); }
},120000);
