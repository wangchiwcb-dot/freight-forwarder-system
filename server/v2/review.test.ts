import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from './app';
import { connectDatabase, migrate, type Database } from './database';
import { getOffers, publicationIssues, saveDraft } from './repository';
import { prepareOffer } from './review';
import { prepareOwnUs } from './own-us';
import type { PriceDraftRecord } from '../../src/domain/v2/review-contracts';
import type { PricingRequest } from '../../src/domain/v2/pricing-contracts';

const request: PricingRequest = {
  country:'US',origin:'',postalCode:'90001',warehouseCode:'',addressType:'commercial',cargoAttributes:[],
  intellectualProperty:'clear',modes:['sea'],asOf:'2026-10-26',measurementStage:'estimated',
  packages:[],actualKg:'20',volumeCbm:'0.1',pieces:1,includeExamples:false,trialBilling:null,
};

const sourceId = '97ea96986ab72065d60b6707adf3d6502ba4be724b5e72c38b7d5aa78981caf3';
const quote = {
  id:'source-quote', providerId:'own', providerName:'自有测试', isOwn:true, channelName:'盐田定时达海派',
  countryCode:'US', mode:'sea', destinationLabel:'美西 80001-96999', origin:'待核',
  warehouseCodes:[], postalCodes:[], postalPrefixes:[], postalRanges:[{start:'80001',end:'96999'}],
  billingBasis:'kg', currency:'CNY', tiers:[{ label:'15-51kg',min:15,max:51,minInclusive:true,maxInclusive:false,price:15.4,status:'priced',sourceCell:'D15' }],
  volumetricDivisor:null,minShipmentKg:null,minPieceKg:null,minCbm:null,priceDate:'2026-10-19',effectiveAt:null,
  notes:[],source:{fileId:'own',fileName:'test.xlsx',sheet:'美国海派',cells:['D15'],hidden:false},
};
let db: Database;
let app: ReturnType<typeof createApp>;
let directory:string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(),'freight-review-'));
  const original = join(directory,'original.xlsx'); await writeFile(original,'test original content');
  db = await connectDatabase({memory:true}); await migrate(db); app = createApp(db);
  await db.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata)
    VALUES($1,$1,'原表.xlsx',21,$2,'private/evidence','extracted','{}')`,[sourceId,original]);
  await db.query(`INSERT INTO quotation_v2.draft_note_sets VALUES('notes','["原表完整备注"]')`);
  for (let i=0;i<2;i++) await db.query(`INSERT INTO quotation_v2.price_drafts(id,source_id,source_quote_id,parser_version,provider_hint,channel_hint,country_hint,mode_hint,proposed_data,note_set_id)
    VALUES($1,$2,$1,'test','自有测试',$3,'US','sea',$4,'notes')`,[`draft_${i}`,sourceId,quote.channelName,JSON.stringify({...quote,id:`q${i}`})]);
},30000);
afterAll(async () => {
  await app?.close(); await db?.close();
  if (directory && resolve(directory).startsWith(resolve(tmpdir())+sep)) await rm(directory,{recursive:true,force:true});
});

describe('real source review workflow', () => {
  it('searches and paginates real prices, retrieves full notes, and downloads the original without exposing paths', async () => {
    const page = await app.inject({url:'/api/v2/price-drafts?country=US&mode=sea&page=2&pageSize=1&q=80001'});
    expect(page.statusCode).toBe(200); expect(page.json().total).toBe(2); expect(page.json().items).toHaveLength(1);
    expect(page.json().items[0].proposed_data.notes).toBeUndefined();
    expect((await app.inject({url:'/api/v2/price-drafts?country=DE'})).json().total).toBe(0);
    expect((await app.inject({url:'/api/v2/price-drafts?page=0'})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/v2/price-drafts/draft_0'})).json().proposed_data.notes).toEqual(['原表完整备注']);
    const download=await app.inject({url:`/api/v2/sources/${sourceId}/download`});
    expect(download.statusCode).toBe(200); expect(download.body).toBe('test original content');
    expect(download.headers['content-disposition']).toContain('attachment'); expect(page.body).not.toContain('private/');
  });
  it('prepares confirmed own-US billing but leaves dates, scope and uncertain rules unreviewed', async () => {
    const response = await app.inject({method:'POST',url:'/api/v2/price-drafts/draft_0/prepare',payload:{mode:'sea',country:'US'}});
    expect(response.statusCode).toBe(200);
    const {offer,issues}=response.json();
    expect(offer.billing).toMatchObject({aggregation:'shipment',volumeStepCbm:'0.1',volumetricDivisor:'6000',quantityStep:'1',minimumQuantity:'12',minimumPieceKg:'0',verified:true});
    expect(offer.validFrom).toBeNull(); expect(offer.scopeKey).toBeNull(); expect(issues.length).toBeGreaterThan(0);
    expect(await getOffers(db)).toHaveLength(0); // preparation alone does not save or publish
    const raw=(await app.inject({url:'/api/v2/price-drafts/draft_0'})).json() as PriceDraftRecord;
    expect(prepareOffer(raw,{mode:'air',country:'US'}).billing.volumeStepCbm).toBeNull();
    const matson=prepareOffer({...raw,proposed_data:{...raw.proposed_data,channelName:'美森限时达海派'}},{mode:'sea',country:'US'});
    expect(matson.billing).toMatchObject({minimumPieceKg:'12',minimumQuantity:'0',minimumPieceApplication:'actual_before_shipment_max',verified:true});
    expect(publicationIssues(matson).join(' ')).not.toContain('计算顺序');
    expect(prepareOffer({...raw,source_id:'b'.repeat(64)},{mode:'sea',country:'US'}).billing.verified).toBe(false);
  });
  it('links saved versions atomically to their source and rejects unrelated evidence', async () => {
    const {offer}=(await app.inject({method:'POST',url:'/api/v2/price-drafts/draft_0/prepare',payload:{mode:'sea',country:'US'}})).json();
    const invalid={...offer,id:'bad-link',sourceEvidence:[{...offer.sourceEvidence[0],sourceId:null}]};
    expect((await app.inject({method:'POST',url:'/api/v2/review/offers',payload:{offer:invalid,sourceDraftId:'draft_0'}})).statusCode).toBe(409);
    expect(await getOffers(db,{id:'bad-link'})).toHaveLength(0);
    expect((await app.inject({method:'POST',url:'/api/v2/review/offers',payload:{offer,sourceDraftId:'draft_0'}})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/v2/price-drafts/draft_0'})).json().status).toBe('mapped');
    expect((await app.inject({method:'POST',url:`/api/v2/offers/${offer.id}/publish`})).statusCode).toBe(409);
    const preview=await app.inject({method:'POST',url:'/api/v2/review/preview',payload:{offer,request}});
    expect(preview.json().items[0]).toMatchObject({state:'partial',total:null,lowest:false});
    expect(publicationIssues({...offer,billing:{...offer.billing,volumeStepCbm:null}})).toContain('整票体积进位规则未补齐');
  });
  it('prepares only unlinked own-US drafts once, without publishing or altering existing versions', async () => {
    expect(await prepareOwnUs(db)).toEqual({created:1,published:0});
    expect(await prepareOwnUs(db)).toEqual({created:0,published:0});
    const offers=await getOffers(db); expect(offers).toHaveLength(2);
    expect(offers.every(offer=>offer.status==='draft')).toBe(true);
    expect((await app.inject({url:'/api/v2/readiness'})).json()).toMatchObject({priceDrafts:2,ruleDrafts:2,published:0});
  });
  it('upgrades only untouched initial drafts, records previous values, and leaves saved edits and snapshots intact', async () => {
    const raw=(await app.inject({url:'/api/v2/price-drafts/draft_0'})).json() as PriceDraftRecord;
    const original=prepareOffer(raw,{mode:'sea',country:'US'});
    original.id='legacy-minimum'; original.channelId='legacy-minimum';
    original.billing.minimumQuantity='0';original.billing.verified=false;delete original.billing.minimumPieceApplication;
    await saveDraft(db,original,'draft_0');
    await saveDraft(db,{...original,id:'user-edited',billing:{...original.billing,minimumQuantity:'25'}},'draft_0');
    const snapshot=await app.inject({method:'POST',url:'/api/v2/quotes/calculate',payload:{request}});
    const migration=await readFile(new URL('./migrations/0006_own_us_confirmed_minimum.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    expect((await getOffers(db,{id:original.id}))[0].billing).toMatchObject({minimumQuantity:'12',verified:true});
    expect((await getOffers(db,{id:'user-edited'}))[0].billing.minimumQuantity).toBe('25');
    const audits=await db.query<any>("SELECT detail FROM quotation_v2.audit_logs WHERE action='own_us_minimum_confirmed' AND entity_id=$1",[original.id]);
    expect(audits.rows).toHaveLength(1);expect(audits.rows[0].detail.previousBilling.minimumQuantity).toBe('0');
    const saved=(await app.inject({url:`/api/v2/quotes/runs/${snapshot.json().runId}`})).json();
    expect(saved.items.find((item:any)=>item.offer.id===original.id).offer.billing.minimumQuantity).toBe('0');
  });
});
