import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { connectDatabase, migrate, type Database } from './database';
import { createApp } from './app';
import { prepareOffer } from './review';
import { saveDraft, publishRelease } from './repository';
import { estimateSource, fromRuleResult, rankComparison } from '../../src/domain/v2/comparison';
import { calculateOffers } from '../../src/domain/v2/pricing';
import { comparisonInputSchema, comparisonOptionsSchema } from '../../src/domain/v2/comparison-contracts';
import type { DraftQuote, PriceDraftRecord } from '../../src/domain/v2/review-contracts';

const sourceId='a'.repeat(64);
const quote:DraftQuote={id:'q',providerId:'p',providerName:'代理',isOwn:false,channelName:'渠道',countryCode:'US',mode:'sea',delivery:'all',origin:'深圳',destinationLabel:'90001',
  warehouseCodes:[],postalCodes:['90001'],postalPrefixes:[],cargoTypes:['general'],cargoCertainty:'explicit',billingBasis:'kg',currency:'CNY',currencyEvidence:'explicit',
  tiers:[{label:'0kg以上',min:0,max:null,price:10,status:'priced',sourceCell:'A1'}],volumetricDivisor:6000,minShipmentKg:0,minPieceKg:0,minCbm:0,maxKgPerCbm:null,
  transitText:'30天提取',notes:[],priceDate:'2026-10-01',effectiveAt:'2026-10-01',dateKind:'explicit',status:'reference',reviewReasons:[],
  reliability:{level:'unknown',note:'待核'},source:{fileId:'s',fileName:'source.xlsx',sheet:'海运',cells:['A1'],hidden:false}};
const draft=(id='draft',changes:Partial<DraftQuote>={}):PriceDraftRecord=>({id,source_id:sourceId,source_name:'source.xlsx',provider_hint:`代理${id}`,channel_hint:`渠道${id}`,country_hint:'US',mode_hint:'sea',status:'needs_review',proposed_data:{...structuredClone(quote),...changes}});
const input=comparisonInputSchema.parse({request:{country:'US',origin:'深圳',postalCode:'90001',warehouseCode:'',addressType:'commercial',cargoAttributes:[],intellectualProperty:'clear',modes:['sea','rail','road','air'],asOf:'2026-10-26',measurementStage:'estimated',packages:[],actualKg:'100',volumeCbm:'1.2',pieces:5,includeExamples:false,trialBilling:null}});
const options=comparisonOptionsSchema.parse({});

describe('real source comparison arithmetic',()=>{
  it('does not rank a note mistaken for a channel or fees without a calculable base freight',()=>{
    const note=draft();note.channel_hint='请注意：上海仓另加费用';
    expect(estimateSource(note,input.request,options).knownCost).toBeNull();
    const offer=prepareOffer(draft(),{mode:'sea',country:'US'});
    offer.rules=[{id:'declaration',label:'报关',kind:'fee',scope:'shipment',condition:null,inclusion:'additional',basis:'shipment',rate:'200',percentBase:[],minimum:null,maximum:null,evidence:'200/票'}];
    const result=calculateOffers([offer],{...input.request,actualKg:null,volumeCbm:null})[0];
    expect(result.knownSubtotal).toBe('200.00');
    const row=fromRuleResult(result,draft());expect(row.knownCost).toBeNull();expect(rankComparison([row])[0].lowestReference).toBe(false);
  });
  it('uses each source divisor, requires explicit fallback, and labels reference assumptions',()=>{
    const own=estimateSource(draft(),input.request,options);expect(own.quantity).toBe('200');expect(own.knownCost).toBe('2000.00');expect(own.completeCost).toBeNull();
    const missing=draft('missing',{volumetricDivisor:null});expect(estimateSource(missing,input.request,options).knownCost).toBeNull();
    const fallback=estimateSource(missing,input.request,{...options,fallbackDivisor:'5000'});expect(fallback.quantity).toBe('240');expect(fallback.assumptions.join()).toContain('手填');
    expect(estimateSource(draft(),input.request,{...options,fallbackDivisor:'5000'}).quantity).toBe('200');
  });
  it('does not guess per-piece minimum order, includes confirmed fixed fees and separates currencies',()=>{
    expect(estimateSource(draft('min',{minPieceKg:12}),input.request,options).knownCost).toBeNull();
    const cbm=estimateSource(draft('cbm',{billingBasis:'cbm',currency:'USD',tiers:[{...quote.tiers[0],price:100,fixedFee:20,fixedFeeBasis:'shipment',fixedFeeConfirmed:true}]}),input.request,options);
    expect(cbm.knownCost).toBe('140.00');expect(cbm.knownSurcharges).toBe('20.00');
    const rows=rankComparison([estimateSource(draft(),input.request,options),cbm]);expect(rows.every(row=>row.lowestReference)).toBe(true);
  });
  it('excludes destination, date, hidden and forbidden cargo mismatches',()=>{
    for(const change of [{postalCodes:['10001']},{validTo:'2026-10-26'},{source:{...quote.source,hidden:true}},{cargoAcceptance:[{type:'general' as const,acceptance:'forbidden' as const,evidenceKind:'explicit',conditions:[],evidence:'不接'}]}]) {
      const row=estimateSource(draft('bad',change),input.request,options);expect(row.status).toBe('unavailable');expect(rankComparison([row])[0].lowestReference).toBe(false);
    }
  });
  it('uses exclusive tier upper bounds by default and rejects overlaps',()=>{
    const tiers=[{...quote.tiers[0],max:200},{...quote.tiers[0],min:200,price:8}];
    expect(estimateSource(draft('tier',{tiers}),input.request,options).unitPrice).toBe('8');
    tiers[0].maxInclusive=true;expect(estimateSource(draft('overlap',{tiers}),input.request,options).status).toBe('inquiry');
  });
});

let db:Database,app:ReturnType<typeof createApp>;
beforeAll(async()=>{
  db=await connectDatabase({memory:true});await migrate(db);app=createApp(db);
  await db.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata) VALUES($1,$1,'source.xlsx',1,'unused','unused','extracted','{}')`,[sourceId]);
  for(let i=0;i<22;i++) {
    const row=draft(`draft_${i}`,{tiers:[{...quote.tiers[0],price:30-i}]});
    await db.query(`INSERT INTO quotation_v2.price_drafts(id,source_id,source_quote_id,parser_version,provider_hint,channel_hint,country_hint,mode_hint,proposed_data) VALUES($1,$2,$1,'test',$3,$4,'US','sea',$5)`,[row.id,sourceId,row.provider_hint,row.channel_hint,JSON.stringify(row.proposed_data)]);
  }
},30000);
afterAll(async()=>{await app?.close();await db?.close();});
describe('comparison API snapshots and managed version selection',()=>{
  it('ranks every real candidate before paging and preserves historical results',async()=>{
    const response=await app.inject({method:'POST',url:'/api/v2/comparisons',payload:input});expect(response.statusCode).toBe(200);
    const run=response.json();expect(run.total).toBe(22);expect(run.items).toHaveLength(15);expect(run.items[0].draftId).toBe('draft_21');expect(run.items[0].knownCost).toBe('1800.00');
    const second=(await app.inject({url:`/api/v2/comparisons/${run.id}?page=2`})).json();expect(second.items).toHaveLength(7);expect(second.items[0].draftId).toBe('draft_6');
    const next=(await app.inject({method:'POST',url:'/api/v2/comparisons',payload:{...input,supersedes:run.id,request:{...input.request,actualKg:'300'}}})).json();expect(next.supersedes).toBe(run.id);expect(next.items[0].knownCost).toBe('2700.00');
    expect((await app.inject({url:`/api/v2/comparisons/${run.id}`})).json().items[0].knownCost).toBe('1800.00');
    expect((await app.inject({url:`/api/v2/comparisons/${run.id}?page=0`})).statusCode).toBe(400);
  });
  it('uses managed billing without raw duplication and keeps active publication ahead of later drafts',async()=>{
    const row=draft('draft_0');const offer=prepareOffer(row,{mode:'sea',country:'US'});
    offer.billing={...offer.billing,verified:true,volumetricDivisor:'6000',volumeStepCbm:'0.1',quantityStep:'1',dimensionStepCm:'0',minimumPieceKg:'12',minimumPieceApplication:'actual_before_shipment_max'};
    offer.tiers=[{id:'tier',min:'0',max:null,minInclusive:true,maxInclusive:false,unitPrice:'15',status:'priced'}];
    const saved=await saveDraft(db,offer,row.id);
    const packages=[{id:'one',pieces:1,actualKg:'30',lengthCm:'50',widthCm:'30',heightCm:'20'},{id:'two',pieces:1,actualKg:'5',lengthCm:'60',widthCm:'50',heightCm:'40'}];
    const selected={...input,request:{...input.request,packages},options:{...options,selectedDraftIds:[row.id]}};
    let run=(await app.inject({method:'POST',url:'/api/v2/comparisons',payload:selected})).json();expect(run.total).toBe(1);expect(run.items[0].quantity).toBe('42');expect(run.items[0].knownCost).toBe('630.00');
    const ready={...saved,id:'published',reviewed:true,cargoReviewed:true,acceptedAttributes:[],reviewReasons:[],scopeKey:'door',serviceDescription:'door',origin:'深圳',rules:[]};
    await saveDraft(db,ready);await publishRelease(db,'published');
    await saveDraft(db,{...ready,id:'new-draft',tiers:[{...ready.tiers[0],unitPrice:'1'}]});
    run=(await app.inject({method:'POST',url:'/api/v2/comparisons',payload:selected})).json();expect(run.items).toHaveLength(1);expect(run.items[0].offerId).toBe('published');expect(run.items[0].completeCost).toBe('630.00');
  });
  it('does not resurrect revoked sources or inactive channels as raw cheap rows',async()=>{
    const row=draft('draft_1');const offer=prepareOffer(row,{mode:'sea',country:'US'});await saveDraft(db,offer,row.id);
    await db.query("UPDATE quotation_v2.channel_releases SET status='revoked' WHERE id=$1",[offer.id]);
    const payload={...input,options:{...options,selectedDraftIds:[row.id]}};
    const run=(await app.inject({method:'POST',url:'/api/v2/comparisons',payload})).json();expect(run.total).toBe(0);expect(run.summary.unavailable).toBe(1);
    const full=(await app.inject({url:`/api/v2/comparisons/${run.id}?showUnavailable=true`})).json();expect(full.items[0].status).toBe('unavailable');
    await db.query('UPDATE quotation_v2.channels SET active=false WHERE id=$1',[offer.channelId]);
    expect((await app.inject({method:'POST',url:'/api/v2/comparisons',payload})).json().summary.candidates).toBe(0);
  });
});
