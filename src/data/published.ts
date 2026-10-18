import { z } from 'zod';
import { catalogSchema, quoteSchema } from './repository';
import { searchQuotes } from '../domain/search';
import type { Catalog, Quote, HistoryEntry, SearchResponse } from '../domain/types';
import type { SearchRequest } from '../api/contracts';

export interface PublishedManifest {version:string;defaultSnapshotId:string;snapshots:string[];verifiedAt:string;databaseSha256:string;quotes:number;}
export type ReadPublished=(path:string)=>Promise<unknown>;
const snapshotId=z.string().regex(/^snapshot_[a-f0-9]{32}$/);
const manifestSchema=z.object({version:z.string().regex(/^[a-f0-9]{16}$/),defaultSnapshotId:snapshotId,snapshots:z.array(snapshotId),verifiedAt:z.iso.datetime({offset:true}),databaseSha256:z.string().regex(/^[a-f0-9]{64}$/),quotes:z.number().int().nonnegative()})
  .refine(m=>m.databaseSha256.startsWith(m.version)&&m.snapshots.includes(m.defaultSnapshotId),'发布快照清单不一致');
const provenanceSchema=z.object({source:z.literal('published-snapshot'),version:z.string(),verifiedAt:z.string(),message:z.string()});
const publishedCatalogSchema=catalogSchema.extend({snapshotId,snapshots:z.array(z.object({id:snapshotId,name:z.string(),observedDate:z.string().nullable(),sourceKind:z.string()})),provenance:provenanceSchema});
const indexSchema=z.record(z.string(),z.object({path:z.string(),itemId:z.string().regex(/^item_[a-f0-9]{32}$/),snapshots:z.array(z.string())}));
export class PublishedRepository {
  private manifest?:Promise<PublishedManifest>;
  private chunks=new Map<string,Promise<Quote[]>>();
  private indexes=new Map<string,Promise<z.infer<typeof indexSchema>>>();
  constructor(private read:ReadPublished){}
  getManifest(){return this.manifest??=this.read('manifest.json').then(value=>manifestSchema.parse(value)).catch(error=>{this.manifest=undefined;throw error;});}
  async catalog(snapshotId?:string):Promise<Catalog>{
    const m=await this.getManifest();const id=snapshotId??m.defaultSnapshotId;
    if(!m.snapshots.includes(id))throw new Error('发布快照中没有此资料集');
    const catalog=publishedCatalogSchema.parse(await this.read(`${m.version}/catalog-${id}.json`));
    if(catalog.snapshotId!==id||catalog.provenance.version!==m.version||catalog.provenance.verifiedAt!==m.verifiedAt)
      throw new Error('发布快照版本不一致');
    return catalog as Catalog;
  }
  private async chunk(path:string):Promise<Quote[]>{
    const cached=this.chunks.get(path);if(cached)return cached;
    const pending=(async()=>{
      if(!/^quotes-[a-zA-Z0-9_-]+\.json$/.test(path))throw new Error('快照分片路径无效');
      const m=await this.getManifest();
      const body=z.object({quotes:z.array(quoteSchema.extend({ruleRef:z.string()})),notes:z.record(z.string(),z.array(z.string()))}).parse(await this.read(`${m.version}/${path}`));
      return body.quotes.map(q=>{const notes=body.notes[q.ruleRef];if(!notes)throw new Error('快照规则缺失');const {ruleRef,...quote}=q;return {...quote,notes} as Quote;});
    })();
    this.chunks.set(path,pending);pending.catch(()=>this.chunks.delete(path));return pending;
  }
  private async entry(id:string){
    if(!/^version_[a-f0-9]{32}$/.test(id))throw new Error('快照报价不存在');
    const m=await this.getManifest();
    const bucket=id.slice(-2);
    if(!this.indexes.has(bucket))this.indexes.set(bucket,this.read(`${m.version}/index-${bucket}.json`).then(v=>indexSchema.parse(v)).catch(e=>{this.indexes.delete(bucket);throw e;}));
    const index=await this.indexes.get(bucket)!;
    if(!index[id])throw new Error('快照报价不存在');
    return index[id];
  }
  async quote(id:string):Promise<Quote>{
    const entry=await this.entry(id);
    const quote=(await this.chunk(entry.path)).find(q=>q.id===id);if(!quote||quote.itemId!==entry.itemId)throw new Error('快照报价不存在');return quote;
  }
  async search(request:SearchRequest):Promise<SearchResponse>{
    const catalog=await this.catalog(request.snapshotId);
    const country=request.criteria.country;
    const chunks=catalog.chunks.filter(c=>country==='ALL'||c.country===country||(c.country==='EU'&&['DE','FR','IT','ES','PL','CZ'].includes(country)));
    const quotes:Quote[]=[];
    // Limit concurrent downloads and retain immutable, validated chunks for paging.
    for(let i=0;i<chunks.length;i+=4)quotes.push(...(await Promise.all(chunks.slice(i,i+4).map(c=>this.chunk(c.path)))).flat());
    quotes.sort((a,b)=>a.id.localeCompare(b.id));
    const results=searchQuotes(quotes,request.criteria);
    return {items:results.slice((request.page-1)*request.pageSize,request.page*request.pageSize),total:results.length,
      computedCount:results.filter(r=>r.estimatedCost!==null).length,pendingCount:results.filter(r=>!r.eligible).length,
      page:request.page,pageSize:request.pageSize,snapshotId:catalog.snapshotId!,provenance:catalog.provenance};
  }
  async history(id:string,page:number,pageSize:number){
    const quote=await this.quote(id),m=await this.getManifest();
    const index=z.record(z.string(),z.array(z.string().regex(/^version_[a-f0-9]{32}$/))).parse(await this.read(`${m.version}/items-${quote.itemId!.slice(-2)}.json`));
    const ids=index[quote.itemId!]??[];const quotes:Quote[]=[];
    for(let i=0;i<ids.length;i+=4)quotes.push(...await Promise.all(ids.slice(i,i+4).map(id=>this.quote(id))));
    quotes.sort((a,b)=>(b.effectiveAt??b.priceDate??'').localeCompare(a.effectiveAt??a.priceDate??'')||a.id.localeCompare(b.id));
    const items:HistoryEntry[]=await Promise.all(quotes.slice((page-1)*pageSize,page*pageSize).map(async q=>({id:q.id,quotedOn:q.priceDate,validFrom:q.effectiveAt,
      validTo:q.validTo??null,dateEvidence:q.dateKind,fileName:q.source.fileName,sheet:q.source.sheet,taxMode:q.tax!.mode,snapshots:(await this.entry(q.id)).snapshots,tiers:q.tiers})));
    return {items,total:ids.length,page,pageSize,identityNote:'已核对发布快照中的同条件历史报价；同条件多来源均保留，不自动认定最新导入记录为当前价。'};
  }
}
