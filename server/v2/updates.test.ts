import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createApp } from './app';
import { connectDatabase,migrate,type Database } from './database';
import { getOffers,publicationIssues,publishRelease,saveDraft } from './repository';
import { getPriceDraft,prepareOffer } from './review';
import type { DraftQuote } from '../../src/domain/v2/review-contracts';
import type { QuoteUpdateInput } from '../../src/domain/v2/update-contracts';
import { comparisonOptionsSchema } from '../../src/domain/v2/comparison-contracts';
const defaultOptions=comparisonOptionsSchema.parse({});

let db:Database,app:ReturnType<typeof createApp>;
const source=(letter:string)=>letter.repeat(64);
const request={country:'US',origin:'深圳',postalCode:'90001',warehouseCode:'',addressType:'commercial',cargoAttributes:[],intellectualProperty:'clear',
  modes:['sea'],asOf:'2026-10-26',measurementStage:'estimated',packages:[],actualKg:'100',volumeCbm:'0.1',pieces:1,includeExamples:false,trialBilling:null};
const quote=(channel:string,price:number):DraftQuote=>({id:channel,providerId:'agent',providerName:'每周代理',isOwn:false,channelName:channel,countryCode:'US',mode:'sea',delivery:'all',
  origin:'深圳',destinationLabel:'美西',warehouseCodes:[],postalCodes:['90001'],postalPrefixes:[],cargoTypes:[],cargoCertainty:'unknown',billingBasis:'kg',currency:'CNY',currencyEvidence:'explicit',
  tiers:[{label:'0kg起',min:0,max:null,minInclusive:true,maxInclusive:false,price,status:'priced',sourceCell:'D10'}],volumetricDivisor:6000,minShipmentKg:null,minPieceKg:null,minCbm:null,maxKgPerCbm:null,
  transitText:'30天',notes:[],priceDate:'2026-10-21',effectiveAt:null,dateKind:'filename',status:'reference',reviewReasons:[],
  source:{fileId:'file',fileName:'报价.xlsx',sheet:'美国海派',cells:['D10'],hidden:false}});
async function addSource(letter:string,pending=false) {
  await db.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata,pricing_state)
    VALUES($1,$1,$2,1,'unused','unused','extracted','{}',$3)`,[source(letter),`${letter}.xlsx`,pending?'pending':'legacy']);
}
async function addPrice(id:string,file:string,channel:string,price:number,patch:Partial<DraftQuote>={}) {
  const data={...quote(channel,price),...patch};
  await db.query(`INSERT INTO quotation_v2.price_drafts(id,source_id,source_quote_id,parser_version,provider_hint,channel_hint,country_hint,mode_hint,proposed_data)
    VALUES($1,$2,$1,'test',$3,$4,'US','sea',$5)`,[id,source(file),data.providerName,channel,JSON.stringify(data)]);
}
const update=(file:string,previous:string|null,date='2026-10-28'):QuoteUpdateInput=>({sourceId:source(file),previousSourceId:previous?source(previous):null,label:`${file} 本期`,effectiveFrom:date,mappings:[]});
async function preview(value:QuoteUpdateInput) {
  const response=await app.inject({method:'POST',url:'/api/v2/quote-updates/preview',payload:{update:value}});
  expect(response.statusCode,response.body).toBe(200);return response.json();
}
async function activate(value:QuoteUpdateInput,token?:string) {
  const result=await app.inject({method:'POST',url:'/api/v2/quote-updates/activate',payload:{update:value,token:token??(await preview(value)).token}});
  expect(result.statusCode,result.body).toBe(200);return result.json();
}
async function compare(asOf:string) {
  const result=await app.inject({method:'POST',url:'/api/v2/comparisons',payload:{request:{...request,asOf},options:defaultOptions,supersedes:null}});
  expect(result.statusCode,result.body).toBe(200);return result.json();
}
beforeAll(async()=>{
  db=await connectDatabase({memory:true});await migrate(db);app=createApp(db);
  await addSource('a');await addSource('b',true);await addSource('c');await addSource('d',true);
  await addPrice('old-a','a','渠道 A',10);await addPrice('retained','a','本期未出现的渠道',20);
  await addPrice('new-a','b','渠道 A',12);await addPrice('third-a','d','渠道 A',14);
  await addPrice('other-agent','c','其他代理渠道',30,{providerId:'another',providerName:'没有新表的代理'});
},30000);
afterAll(async()=>{await app?.close();await db?.close();});

describe('weekly source lifecycle',()=>{
  it('stages incoming sources and rejects premature rule preparation',async()=>{
    const result=await compare('2026-10-29');
    expect(result.items.map((r:any)=>r.draftId).sort()).toEqual(['old-a','other-agent','retained']);
    const search=(await app.inject({url:'/api/v2/price-drafts?asOf=2026-10-29'})).json();expect(search.total).toBe(3);
    expect((await app.inject({url:'/api/v2/price-drafts?history=true'})).json().total).toBe(5);
    expect((await app.inject({method:'POST',url:'/api/v2/price-drafts/new-a/prepare',payload:{mode:'sea',country:'US'}})).statusCode).toBe(409);
  });
  it('switches by date, retains absent agents/channels, and preserves saved snapshots',async()=>{
    const before=await compare('2026-10-29'),input=update('b','a'),plan=await preview(input);
    expect(plan.summary).toMatchObject({matched:1,changed:1,retained:1,ambiguous:0});
    await activate(input,plan.token);
    expect((await compare('2026-10-27')).items.find((r:any)=>r.draftId==='old-a').unitPrice).toBe('10');
    const current=await compare('2026-10-28');
    expect(current.items.map((r:any)=>r.draftId).sort()).toEqual(['new-a','other-agent','retained']);
    expect(current.items.find((r:any)=>r.draftId==='new-a').unitPrice).toBe('12');
    expect((await app.inject({url:`/api/v2/comparisons/${before.id}`})).json().items.find((r:any)=>r.draftId==='old-a').unitPrice).toBe('10');
    expect((await app.inject({url:'/api/v2/price-drafts?asOf=2026-10-28'})).json().items.map((r:any)=>r.id).sort()).toEqual(['new-a','other-agent','retained']);
    expect((await activate(input,plan.token)).reused).toBe(true);
    expect((await db.query('SELECT id FROM quotation_v2.quote_updates')).rows).toHaveLength(1);
  });
  it('carries missing channels through later weeks and rejects stale predecessors',async()=>{
    expect((await app.inject({method:'POST',url:'/api/v2/quote-updates/preview',payload:{update:update('d','a','2026-11-04')}})).statusCode).toBe(409);
    const plan=await preview(update('d','b','2026-11-04'));expect(plan.summary.retained).toBe(1);
    await activate(update('d','b','2026-11-04'),plan.token);
    expect((await compare('2026-11-03')).items.some((r:any)=>r.draftId==='new-a')).toBe(true);
    const next=await compare('2026-11-04');expect(next.items.some((r:any)=>r.draftId==='third-a')).toBe(true);
    expect(next.items.some((r:any)=>r.draftId==='retained')).toBe(true);
  });
  it('rejects cross-agent pairing, backwards dates and stale previews without partial activation',async()=>{
    await addSource('e',true);await addPrice('later','e','渠道 A',16);
    expect((await app.inject({method:'POST',url:'/api/v2/quote-updates/preview',payload:{update:update('e','c','2026-11-11')}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/api/v2/quote-updates/preview',payload:{update:update('e','d','2026-11-01')}})).statusCode).toBe(409);
    const input=update('e','d','2026-11-11'),plan=await preview(input);
    await db.query(`UPDATE quotation_v2.price_drafts SET proposed_data=jsonb_set(proposed_data,'{tiers,0,price}','17') WHERE id='later'`);
    const result=await app.inject({method:'POST',url:'/api/v2/quote-updates/activate',payload:{update:input,token:plan.token}});
    expect(result.statusCode).toBe(409);expect(result.body).toContain('重新预览');
    expect((await db.query('SELECT id FROM quotation_v2.quote_updates WHERE source_id=$1',[source('e')])).rows).toHaveLength(0);
    expect((await compare('2026-11-11')).items.some((r:any)=>r.draftId==='third-a')).toBe(true);
  });
  it('requires explicit mapping for duplicate identities and never replaces an old row twice',async()=>{
    await addSource('f');await addSource('g',true);
    await addPrice('dup-1','f','重复渠道',8);await addPrice('dup-2','f','重复渠道',9);await addPrice('dup-new','g','重复渠道',10);
    const input=update('g','f'),plan=await preview(input);expect(plan.summary.ambiguous).toBe(1);
    expect((await app.inject({method:'POST',url:'/api/v2/quote-updates/activate',payload:{update:input,token:plan.token}})).statusCode).toBe(409);
    const chosen={...input,mappings:[{draftId:'dup-new',previousDraftId:'dup-2'}]};await activate(chosen);
    expect((await db.query<any>("SELECT valid_to FROM quotation_v2.price_periods WHERE draft_id='dup-1'")).rows[0].valid_to).toBeNull();
    expect((await db.query<any>("SELECT family_id FROM quotation_v2.price_periods WHERE draft_id='dup-new'")).rows[0].family_id).toBe('dup-2');
  });
  it('lets a renamed channel keep its family through explicit reviewed mapping',async()=>{
    await db.query(`UPDATE quotation_v2.price_drafts SET channel_hint='渠道 A 新名称',proposed_data=jsonb_set(proposed_data,'{channelName}','"渠道 A 新名称"') WHERE id='later'`);
    const input=update('e','d','2026-11-11');
    expect((await preview(input)).summary.matched).toBe(0);
    const response=await app.inject({method:'POST',url:'/api/v2/quote-updates/candidates',payload:{update:input,draftId:'later',q:'渠道 A'}});
    expect(response.statusCode,response.body).toBe(200);expect(response.json().items.map((r:any)=>r.id)).toEqual(['third-a']);
    const mapped={...input,mappings:[{draftId:'later',previousDraftId:'third-a'}]};
    expect((await preview(mapped)).items[0].changes).toContain('渠道名称或适用范围');await activate(mapped);
    expect((await db.query<any>("SELECT family_id FROM quotation_v2.price_periods WHERE draft_id='later'")).rows[0].family_id).toBe('old-a');
  });
});

describe('managed rules across weekly sources',()=>{
  it('inherits reviewed billing into a new reviewable version, closes old applicability and retains original published rows',async()=>{
    await addSource('h');await addSource('i',true);await addPrice('managed-old','h','自有规则渠道',15);await addPrice('managed-new','i','自有规则渠道',16);
    const raw=(await getPriceDraft(db,'managed-old'))!;
    const offer=prepareOffer(raw,{mode:'sea',country:'US'});
    Object.assign(offer,{validFrom:'2026-10-21',origin:'深圳',scopeKey:'door',reviewed:true,cargoReviewed:true,reviewReasons:[]});
    offer.billing={...offer.billing,verified:true,volumetricDivisor:'6000',volumeStepCbm:'0.1',quantityStep:'1',dimensionStepCm:'0',minimumQuantity:'12'};
    await saveDraft(db,offer,raw.id);expect(publicationIssues(offer)).toEqual([]);await publishRelease(db,offer.id);
    const input=update('i','h'),result=await activate(input);expect(result.inherited).toBe(1);
    const versions=(await getOffers(db)).filter(o=>o.channelId===offer.channelId);
    const next=versions.find(o=>o.id!==offer.id)!;
    expect(next).toMatchObject({revision:2,sourceDraftId:'managed-new',validFrom:'2026-10-28',status:'draft',reviewed:false});
    expect(next.billing).toMatchObject({volumetricDivisor:'6000',minimumQuantity:'12'});
    expect(next.tiers[0].unitPrice).toBe('16');
    expect(versions.find(o=>o.id===offer.id)!.validTo).toBe('2026-10-28');
    expect((await db.query<any>('SELECT valid_to FROM quotation_v2.channel_releases WHERE id=$1',[offer.id])).rows[0].valid_to).toBeNull();
    const before=await compare('2026-10-27'),after=await compare('2026-10-28');
    expect(before.items.some((r:any)=>r.offerId===offer.id)).toBe(true);expect(after.items.some((r:any)=>r.offerId===next.id)).toBe(true);
    expect(after.items.some((r:any)=>r.offerId===offer.id||r.draftId==='managed-old')).toBe(false);
    const reviewed={...next,id:'reviewed-weekly',reviewed:true,cargoReviewed:true,reviewReasons:[]};
    await saveDraft(db,reviewed,'managed-new');await publishRelease(db,reviewed.id);
    expect((await compare('2026-10-28')).items.some((r:any)=>r.offerId===reviewed.id)).toBe(true);
    const manualNext={...reviewed,id:'manual-next-week',validFrom:'2026-11-04',tiers:[{...reviewed.tiers[0],unitPrice:'18'}]};
    await saveDraft(db,manualNext,'managed-new');await publishRelease(db,manualNext.id);
    expect((await getOffers(db,{id:reviewed.id}))[0].validTo).toBe('2026-11-04');
    await expect(db.query("UPDATE quotation_v2.channel_releases SET valid_to='2026-12-01' WHERE id=$1",[reviewed.id])).rejects.toThrow('immutable');
  });
  it('does not revive inactive managed channels as cheap raw prices',async()=>{
    await addSource('j');await addSource('k',true);await addPrice('inactive-old','j','停用渠道',1);await addPrice('inactive-new','k','停用渠道',0.5);
    const draft=(await getPriceDraft(db,'inactive-old'))!,offer=prepareOffer(draft,{mode:'sea',country:'US'});
    await saveDraft(db,offer,draft.id);await db.query('UPDATE quotation_v2.channels SET active=false WHERE id=$1',[offer.channelId]);
    await activate(update('k','j'));
    expect((await getPriceDraft(db,'inactive-new'))!.status).toBe('excluded');
    expect((await compare('2026-10-29')).items.some((r:any)=>r.draftId==='inactive-new')).toBe(false);
  });
  it('does not erase a scheduled publication when a replacement workbook starts earlier',async()=>{
    await addSource('l',true);await addPrice('scheduled-conflict','l','自有规则渠道',19);
    const response=await app.inject({method:'POST',url:'/api/v2/quote-updates/preview',payload:{update:update('l','i','2026-11-03')}});
    expect(response.statusCode).toBe(409);expect(response.body).toContain('未来版本');
    expect((await getOffers(db,{id:'manual-next-week'}))[0].validTo).toBeNull();
  });
});
