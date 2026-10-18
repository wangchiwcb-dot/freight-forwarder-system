import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getCatalog, getQuotes, joins, visible } from '../worker/repository';
import type { Database, Statement } from '../worker/db';
import type { Quote, Catalog } from '../src/domain/types';

const databasePath='.local/d1-import/freight-quotes.sqlite';
const verification=JSON.parse(readFileSync('.local/d1-refinement/sync-completion.json','utf8'));
const hash=createHash('sha256').update(readFileSync(databasePath)).digest('hex');
if (!verification.passed || verification.differences.length || verification.canonical_sha256!==hash)
  throw new Error('Snapshot export requires the exact database verified against D1');
const version=hash.slice(0,16), root=`public/published/${version}`;
const write=(path:string,value:unknown)=>{mkdirSync(root,{recursive:true});writeFileSync(`${root}/${path}`,JSON.stringify(value));};
const sqlite=new DatabaseSync(databasePath,{readOnly:true});
const db:Database={prepare(sql:string):Statement {let args:any[]=[];return {
  bind(...values){args=values;return this;},async all<T>(){return {results:sqlite.prepare(sql).all(...args) as T[]};},
  async first<T>(){return (sqlite.prepare(sql).get(...args) ?? null) as T|null;},
};}};
try {
  const catalog=await getCatalog(db);
  const records=sqlite.prepare(`SELECT v.id,v.batch_id ${joins} WHERE ${visible} ORDER BY v.id`).all() as {id:string;batch_id:string}[];
  const all:Quote[]=[];
  for(let offset=0;offset<records.length;offset+=100) all.push(...await getQuotes(db,records.slice(offset,offset+100).map(row=>row.id)));
  const batchById=new Map(records.map(row=>[row.id,row.batch_id]));
  const groups=new Map<string,Quote[]>();
  for(const quote of all){const key=`${batchById.get(quote.id)}-${quote.countryCode}`;const group=groups.get(key)??[];group.push(quote);groups.set(key,group);}
  const files:{batch:string;country:Quote['countryCode'];path:string;count:number}[]=[];
  const indexes:Record<string,Record<string,{path:string;itemId:string;snapshots:string[]}>>={};
  const namesByBatch=new Map<string,string[]>();
  for(const row of sqlite.prepare('SELECT sb.batch_id,s.name FROM snapshot_batches sb JOIN dataset_snapshots s ON s.id=sb.snapshot_id ORDER BY s.name').all() as {batch_id:string;name:string}[]){
    const names=namesByBatch.get(row.batch_id)??[];names.push(row.name);namesByBatch.set(row.batch_id,names);
  }
  const items:Record<string,Record<string,string[]>>={};
  for(const [key,group] of groups){
    for(let offset=0;offset<group.length;offset+=500){
      const quotes=group.slice(offset,offset+500),path=`quotes-${key}-${offset}.json`;
      const notes:Record<string,string[]>={};
      const packed=quotes.map(q=>{
        const ref=createHash('sha256').update(JSON.stringify(q.notes)).digest('hex').slice(0,16);notes[ref]=q.notes;
        const bucket=q.id.slice(-2);(indexes[bucket]??={})[q.id]={path,itemId:q.itemId!,snapshots:namesByBatch.get(batchById.get(q.id)!)??[]};
        const itemBucket=q.itemId!.slice(-2);((items[itemBucket]??={})[q.itemId!]??=[]).push(q.id);
        return {...q,notes:[],ruleRef:ref};
      });
      write(path,{quotes:packed,notes});
      files.push({batch:batchById.get(quotes[0].id)!,country:quotes[0].countryCode,path,count:quotes.length});
    }
  }
  const provenance={source:'published-snapshot',version,verifiedAt:verification.verified_at,
    message:'当前使用已与云端核对的发布快照；实时数据库读取额度已用尽，快照发布后的变更需待实时服务恢复后读取。'};
  for(const snapshot of catalog.snapshots!){
    const c:Catalog=await getCatalog(db,snapshot.id);
    const batches=new Set((sqlite.prepare('SELECT batch_id FROM snapshot_batches WHERE snapshot_id=?').all(snapshot.id) as {batch_id:string}[]).map(row=>row.batch_id));
    c.chunks=files.filter(file=>batches.has(file.batch)).map(({country,path,count})=>({country,path,count}));
    write(`catalog-${snapshot.id}.json`,{...c,provenance});
  }
  for(const [key,value] of Object.entries(indexes))write(`index-${key}.json`,value);
  for(const [key,value] of Object.entries(items))write(`items-${key}.json`,value);
  mkdirSync('public/published',{recursive:true});
  writeFileSync('public/published/manifest.json',JSON.stringify({version,defaultSnapshotId:catalog.snapshotId,
    snapshots:catalog.snapshots!.map(s=>s.id),verifiedAt:verification.verified_at,databaseSha256:hash,quotes:all.length}));
  console.log(JSON.stringify({version,quotes:all.length,files:files.length,verifiedAt:verification.verified_at}));
} finally {sqlite.close();}
