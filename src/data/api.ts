import { z } from 'zod';
import { catalogSchema, quoteSchema } from './repository';
import { searchSchema } from '../api/contracts';
import type { Catalog, HistoryEntry, Quote, SearchCriteria, SearchResponse } from '../domain/types';
import { PublishedRepository } from './published';

const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/,'') ?? '';
class ServiceError extends Error {constructor(message:string,public code?:string){super(message);}}
let usePublished=false;
const published=new PublishedRepository(async path=>{
  const response=await fetch(`${apiBase}/published/${path}`,{cache:path==='manifest.json'?'no-cache':'force-cache'});
  if(!response.ok)throw new Error(`已核对发布快照读取失败（${response.status}）`);return response.json();
});
const quotaFallback=async<T>(live:()=>Promise<T>,offline:()=>Promise<T>):Promise<T>=>{
  if(usePublished)return offline();
  try{return await live();}catch(error){if(error instanceof ServiceError && error.code==='D1_READ_QUOTA_EXCEEDED'){usePublished=true;return offline();}throw error;}
};
async function request<T>(path: string, schema: z.ZodType, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`,{...init,cache:'no-store'});
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({error:z.object({message:z.string(),code:z.string().optional(),requestId:z.string().optional()})}).safeParse(body);
    throw new ServiceError(error.success ? `${error.data.error.message}（${response.status}）` : `报价服务请求失败（${response.status}）`,error.success?error.data.error.code:undefined);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('报价服务返回格式无效，请重试');
  return parsed.data as T;
}
const count = z.number().int().nonnegative();
const nullableNumber = z.number().finite().nullable();
const resultSchema = z.object({ quote:quoteSchema,tier:z.object({label:z.string(),price:nullableNumber}).passthrough().nullable(),
  estimatedCost:nullableNumber,chargeableQuantity:nullableNumber,estimateLabel:z.string(),warnings:z.array(z.string()),eligible:z.boolean() });
const responseSchema = z.object({items:z.array(resultSchema),total:count,computedCount:count,pendingCount:count,
  page:z.number().int().positive(),pageSize:z.number().int().positive(),snapshotId:z.string()});
const liveCatalogSchema = catalogSchema.extend({ snapshotId:z.string(), snapshots:z.array(z.object({
  id:z.string(),name:z.string(),observedDate:z.string().nullable(),sourceKind:z.string(),
})) });
export const fetchCatalog = async(snapshotId?: string, signal?: AbortSignal) => {
  try {const result=await request<Catalog>(`/catalog${snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : ''}`,liveCatalogSchema,{signal});
    usePublished=Boolean(result.provenance);return result;
  }catch(error){if(error instanceof ServiceError && error.code==='D1_READ_QUOTA_EXCEEDED'){usePublished=true;return published.catalog(snapshotId);}throw error;}
};
export function fetchSearch(criteria: SearchCriteria, snapshotId: string, page: number, signal?: AbortSignal) {
  const body=searchSchema.parse({criteria,snapshotId,page,pageSize:15});
  return quotaFallback(()=>request<SearchResponse>('/quotes/search',responseSchema,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}),()=>published.search(body));
}
export const fetchQuote = (id: string, signal?: AbortSignal) => quotaFallback(()=>request<Quote>(`/quotes/${encodeURIComponent(id)}`,quoteSchema,{signal}),()=>published.quote(id));
const historySchema = z.object({items:z.array(z.object({id:z.string(),quotedOn:z.string().nullable(),validFrom:z.string().nullable(),
  validTo:z.string().nullable(),dateEvidence:z.string(),fileName:z.string(),sheet:z.string(),taxMode:z.string(),
  snapshots:z.array(z.string()),tiers:z.array(z.object({label:z.string(),price:nullableNumber,sourceCell:z.string()}).passthrough()),
})),total:count,page:count,pageSize:count,identityNote:z.string()});
export const fetchHistory = (id:string,page:number,signal?:AbortSignal) => quotaFallback(()=>request<{
  items:HistoryEntry[];total:number;page:number;pageSize:number;identityNote:string;
}>(`/quotes/${encodeURIComponent(id)}/history?page=${page}&pageSize=5`,historySchema,{signal}),()=>published.history(id,page,5));
