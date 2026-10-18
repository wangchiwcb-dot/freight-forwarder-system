import { afterEach, expect, it, vi } from 'vitest';
import { fetchCatalog, fetchQuote, fetchSearch } from './api';
import { DEFAULT_CRITERIA } from '../domain/search';
afterEach(()=>vi.unstubAllGlobals());
const reply=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
it('uses the API with snapshot, page and abort signal instead of static chunks',async()=>{
  const fetcher=vi.fn(()=>reply({items:[],total:0,computedCount:0,pendingCount:0,page:2,pageSize:15,snapshotId:'current'}));
  vi.stubGlobal('fetch',fetcher); const controller=new AbortController();
  const result=await fetchSearch(DEFAULT_CRITERIA,'current',2,controller.signal);
  expect(result.total).toBe(0);
  expect(fetcher).toHaveBeenCalledWith('/api/quotes/search',expect.objectContaining({method:'POST',signal:controller.signal,cache:'no-store'}));
  const options=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(JSON.parse(String(options[1].body))).toMatchObject({snapshotId:'current',page:2});
});
it('rejects incomplete API catalogues and corrupt quotes',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>reply({schemaVersion:'1.0'})));
  await expect(fetchCatalog()).rejects.toThrow('返回格式无效');
  await expect(fetchQuote('version')).rejects.toThrow('返回格式无效');
});
it('shows a useful API failure and does not silently load legacy prices',async()=>{
  const fetcher=vi.fn(()=>reply({error:{message:'报价服务暂时不可用',requestId:'test'}},503)); vi.stubGlobal('fetch',fetcher);
  await expect(fetchCatalog()).rejects.toThrow('报价服务暂时不可用（503）');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects invalid criteria before sending a request',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  expect(()=>fetchSearch({...DEFAULT_CRITERIA,pieces:0},'current',1)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
