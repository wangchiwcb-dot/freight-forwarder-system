import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from '@playwright/test';

const base=process.argv[2];
if(!base || !/^https?:\/\//.test(base)) throw new Error('Usage: node scripts/smoke-api.mjs https://worker.example');
const checks=[];
const client=await request.newContext({proxy:process.env.API_TEST_PROXY ? {server:process.env.API_TEST_PROXY} : undefined});
async function get(path,init,expected=200){
  const start=performance.now();
  const response=await client.fetch(`${base}/api${path}`,{method:init?.method,headers:init?.headers,data:init?.body,timeout:30000});
  const body=await response.json();
  checks.push({path,status:response.status(),ms:Math.round(performance.now()-start)});
  assert.equal(response.status(),expected,JSON.stringify(body));
  return body;
}
const quotaMode=process.argv.includes('--expect-quota');
const health=await get('/health',undefined,quotaMode?503:200);
if(quotaMode){assert.equal(health.error.code,'D1_READ_QUOTA_EXCEEDED');assert.ok(Date.parse(health.error.retryAt)>Date.now());}
else assert.equal(health.status,'ok');
const catalog=await get('/catalog'); assert.ok(catalog.stats.quotes>19000);
const criteria={country:'US',mode:'all',origin:'',destination:'',cargo:'general',cargoShape:'all',actualKg:300,
  volumeCbm:1,pieces:10,providerId:'',onlyOwn:false,includePending:true,sort:'cost',asOf:'2026-10-18'};
const post=(data)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
if(quotaMode){
  assert.equal(catalog.provenance.source,'published-snapshot');
  const failed=await get('/quotes/search',post({criteria,snapshotId:catalog.snapshotId}),503);
  assert.equal(failed.error.code,'D1_READ_QUOTA_EXCEEDED');
  const sources=await get('/sources');assert.equal(sources.items.length,catalog.files.length);
  const asset=await client.get(`${base}/published/manifest.json`,{headers:{Origin:'https://wangchiwcb-dot.github.io'}});
  assert.equal(asset.status(),200);assert.equal(asset.headers()['access-control-allow-origin'],'https://wangchiwcb-dot.github.io');
  assert.ok(asset.headers()['cache-control'].includes('no-cache'));assert.ok(!asset.headers()['cache-control'].includes('immutable'));
  const manifest=await asset.json();assert.equal(manifest.version,catalog.provenance.version);
  const chunk=await client.get(`${base}/published/${manifest.version}/${catalog.chunks[0].path}`);
  assert.equal(chunk.status(),200);assert.ok(chunk.headers()['cache-control'].includes('immutable'));
  assert.equal((await chunk.json()).quotes.length,catalog.chunks[0].count);
  await get('/quotes/search',post({criteria:{...criteria,actualKg:-1}}),400);
  await get('/catalog?snapshotId=missing',undefined,404);await get('/quotes/search',undefined,405);
  const report={base,mode:'quota-with-published-snapshot',liveDatabaseAvailable:false,verifiedAt:new Date().toISOString(),stats:catalog.stats,checks};
  mkdirSync('.local/api-acceptance',{recursive:true});
  writeFileSync(`.local/api-acceptance/${new URL(base).hostname}-quota.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));await client.dispose();process.exit(0);
}
const first=await get('/quotes/search',post({criteria,snapshotId:catalog.snapshotId,page:1,pageSize:15}));
assert.equal(first.items.length,15); assert.ok(first.computedCount>0);
const second=await get('/quotes/search',post({criteria,snapshotId:catalog.snapshotId,page:2,pageSize:15}));
assert.equal(first.total,second.total); assert.ok(second.items.every(r=>!first.items.some(q=>q.quote.id===r.quote.id)));
const detail=await get(`/quotes/${first.items[0].quote.id}`); assert.deepEqual(detail,first.items[0].quote);
const history=await get(`/quotes/${detail.id}/history`); assert.ok(history.items.some(item=>item.id===detail.id));
const sources=await get(`/sources?snapshotId=${catalog.snapshotId}`); assert.equal(sources.items.length,catalog.files.length);
const historical=catalog.snapshots.find(s=>s.sourceKind==='historical_excel');
const old=await get('/quotes/search',post({criteria:{...criteria,country:'ALL'},snapshotId:historical.id})); assert.equal(old.snapshotId,historical.id);
await get('/quotes/search',post({criteria:{...criteria,actualKg:-1}}),400);
await get('/quotes/missing',undefined,404);
await get('/quotes/search',undefined,405);
const report={base,verifiedAt:new Date().toISOString(),stats:catalog.stats,total:first.total,computed:first.computedCount,
  pending:first.pendingCount,checks};
mkdirSync('.local/api-acceptance',{recursive:true});
writeFileSync(`.local/api-acceptance/${new URL(base).hostname}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
await client.dispose();
