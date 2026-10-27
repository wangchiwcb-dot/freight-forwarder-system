import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { date, id, type Offer } from '../../src/domain/v2/pricing-contracts';
import type { PriceDraftRecord } from '../../src/domain/v2/review-contracts';
import type { QuoteUpdateInput, QuoteUpdatePreview, QuoteUpdateRow } from '../../src/domain/v2/update-contracts';
import type { TransportMode } from '../../src/domain/v2/contracts';
import type { Database } from './database';
import { getOffers, saveDraft } from './repository';
import { getPriceDraft, prepareOffer } from './review';

export const updateInputSchema = z.object({
  sourceId:id, previousSourceId:id.nullable().default(null), label:z.string().trim().min(1).max(100), effectiveFrom:date,
  mappings:z.array(z.object({draftId:id,previousDraftId:id.nullable()}).strict()).max(5000).default([]),
}).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');
const normal = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();
const sorted = (values: unknown[] = []) => values.map(value=>normal(typeof value==='object'?JSON.stringify(value):value)).sort();
type Draft = PriceDraftRecord & { family_id?:string; note_set_id:string|null; period_from:string|null; period_to:string|null };
const providerKey = (d:PriceDraftRecord) => `${d.proposed_data.isOwn}:${normal(d.provider_hint)}`;
// Prices, filenames, dates, cells and notes are deliberately not channel identity.
export function quoteIdentity(d:PriceDraftRecord) {
  const q=d.proposed_data;
  return hash([providerKey(d),normal(d.channel_hint),d.country_hint,d.mode_hint,normal(q.origin),
    normal(q.destinationLabel),q.billingBasis,q.currency,q.delivery,sorted(q.cargoTypes),
    sorted(q.warehouseCodes),sorted(q.postalCodes),sorted(q.postalPrefixes),sorted(q.postalRanges)]);
}
const priceText = (d:Draft) => d.proposed_data.tiers.map(t=>`${t.label}: ${t.price??'询价'}`).join('；');
function changes(before:Draft,after:Draft) {
  const a=before.proposed_data,b=after.proposed_data, result:string[]=[];
  if(quoteIdentity(before)!==quoteIdentity(after)) result.push('渠道名称或适用范围');
  const tiers=(d:Draft)=>d.proposed_data.tiers.map(({sourceCell,id,...tier})=>tier);
  if(hash(tiers(before))!==hash(tiers(after))) result.push('价格或档位');
  const billing=(q:typeof a)=>[q.volumetricDivisor,q.minShipmentKg,q.minPieceKg,q.minCbm,q.maxKgPerCbm,q.densityConversionKgPerCbm,q.volumeEquivalentKgPerCbm];
  if(hash(billing(a))!==hash(billing(b))) result.push('计费参数');
  if(hash([a.cargoAcceptance,a.status,a.source.hidden])!==hash([b.cargoAcceptance,b.status,b.source.hidden])) result.push('承运条件');
  if(a.transitText!==b.transitText) result.push('参考时效');
  if((before.note_set_id??hash(a.notes))!==(after.note_set_id??hash(b.notes))) result.push('备注或附加费条款');
  return result;
}
async function loadDrafts(db:Database,sourceId:string|null,seriesId:string|null):Promise<Draft[]> {
  return (await db.query<Draft>(`SELECT d.*,s.original_name AS source_name,
    p.family_id,to_char(p.valid_from,'YYYY-MM-DD') AS period_from,to_char(p.valid_to,'YYYY-MM-DD') AS period_to
    FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id
    LEFT JOIN quotation_v2.price_periods p ON p.draft_id=d.id
    WHERE ($1::text IS NOT NULL AND d.source_id=$1) OR ($2::text IS NOT NULL AND p.series_id=$2 AND p.valid_to IS NULL)
    ORDER BY d.id`,[sourceId,seriesId])).rows;
}

async function planUpdate(db:Database,input:QuoteUpdateInput) {
  if(input.sourceId===input.previousSourceId) throw new Error('新旧报价表不能是同一份文件');
  const sources=(await db.query<{id:string;pricing_state:string}>(`SELECT id,pricing_state FROM quotation_v2.source_files WHERE id=ANY($1::text[])`,[[input.sourceId,input.previousSourceId].filter(Boolean)])).rows;
  const source=sources.find(s=>s.id===input.sourceId),previous=sources.find(s=>s.id===input.previousSourceId);
  if(!source || source.pricing_state!=='pending') throw new Error('请选择尚未生效的新报价表；已经生效的原件不能重复改期');
  if(input.previousSourceId && (!previous || previous.pricing_state==='pending')) throw new Error('上一期必须是已经使用的报价表');
  const previousUpdate=input.previousSourceId?(await db.query<{series_id:string}>('SELECT series_id FROM quotation_v2.quote_updates WHERE source_id=$1',[input.previousSourceId])).rows[0]:null;
  const seriesId=previousUpdate?.series_id ?? input.previousSourceId ?? input.sourceId;
  const head=(await db.query<{source_id:string;effective_from:string}>(`SELECT source_id,to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM quotation_v2.quote_updates WHERE series_id=$1 ORDER BY effective_from DESC LIMIT 1`,[seriesId])).rows[0];
  if(head && head.source_id!==input.previousSourceId) throw new Error('该代理已有更新的报价表，请选择最新一期后重新预览');
  if(head && input.effectiveFrom<=head.effective_from) throw new Error('新一期生效日期必须晚于上一期，临时改价也需要明确新的生效日期');
  const incoming=await loadDrafts(db,input.sourceId,null);
  if(!incoming.length) throw new Error('这份原表尚未解析出价格，请先完成原表解析导入');
  if(incoming.some(row=>row.proposed_data.effectiveAt && input.effectiveFrom<row.proposed_data.effectiveAt.slice(0,10))) throw new Error('确认日期不能早于原表明确的生效日期');
  if(incoming.some(row=>row.proposed_data.validTo && input.effectiveFrom>=row.proposed_data.validTo.slice(0,10))) throw new Error('新原表中存在已过有效期的价格，请核对原表日期');
  const previousRows=head?await loadDrafts(db,null,seriesId):input.previousSourceId?await loadDrafts(db,input.previousSourceId,null):[];
  const providers=new Set(previousRows.map(providerKey));
  if(previousRows.length && incoming.some(row=>!providers.has(providerKey(row)))) throw new Error('新旧报价表的代理身份不同，不能互相替换');
  const oldById=new Map(previousRows.map(row=>[row.id,row]));
  const decisions=new Map(input.mappings.map(m=>[m.draftId,m.previousDraftId]));
  if(decisions.size!==input.mappings.length || input.mappings.some(m=>!incoming.some(row=>row.id===m.draftId))) throw new Error('渠道匹配选择重复或不属于新报价表');
  const groups=new Map<string,Draft[]>(),newCounts=new Map<string,number>();
  for(const row of previousRows) { const key=quoteIdentity(row);groups.set(key,[...(groups.get(key)??[]),row]); }
  for(const row of incoming) { const key=quoteIdentity(row);newCounts.set(key,(newCounts.get(key)??0)+1); }
  const used=new Set<string>();
  const items:QuoteUpdateRow[]=incoming.map(row=>{
    const key=quoteIdentity(row),candidates=groups.get(key)??[];
    let old:Draft|undefined,ambiguous=false;
    if(decisions.has(row.id)) {
      const selected=decisions.get(row.id);
      old=selected?oldById.get(selected):undefined;
      if(selected && !old) throw new Error('所选旧渠道不属于上一期有效报价');
      if(old && (providerKey(row)!==providerKey(old) || row.country_hint!==old.country_hint || row.mode_hint!==old.mode_hint || row.proposed_data.billingBasis!==old.proposed_data.billingBasis || row.proposed_data.currency!==old.proposed_data.currency)) throw new Error('不能关联不同代理、国家、运输方式、币种或计费单位的渠道');
    } else if(candidates.length===1 && newCounts.get(key)===1) old=candidates[0];
    else ambiguous=candidates.length>0;
    if(old) {
      if(used.has(old.id)) throw new Error('同一条旧报价不能同时替换为多条新报价，请核对匹配关系');
      if(old.period_from && input.effectiveFrom<=old.period_from) throw new Error('新报价不能覆盖已有的同日或未来报价');
      const start=old.proposed_data.effectiveAt?.slice(0,10);
      if(start && input.effectiveFrom<=start) throw new Error('新报价生效日期须晚于被替换原表的生效日期');
      used.add(old.id);
    }
    const fields=old?changes(old,row):[];
    return {id:row.id,channel:row.channel_hint,destination:row.proposed_data.destinationLabel,country:row.country_hint,
      previousDraftId:old?.id??null,kind:ambiguous?'ambiguous':old?fields.length?'changed':'unchanged':'new',changes:fields,
      previousPrices:old?priceText(old):'',prices:priceText(row),candidates:candidates.map(old=>({id:old.id,label:`${old.channel_hint} · ${old.proposed_data.destinationLabel} · ${priceText(old)}`}))};
  });
  const summary={total:items.length,matched:used.size,added:items.filter(r=>r.kind==='new').length,
    changed:items.filter(r=>r.kind==='changed').length,unchanged:items.filter(r=>r.kind==='unchanged').length,
    retained:previousRows.length-used.size,ambiguous:items.filter(r=>r.kind==='ambiguous').length};
  const templates=await getOffers(db);
  if(templates.some(offer=>offer.status==='published'&&offer.sourceDraftId&&used.has(offer.sourceDraftId)&&offer.validFrom&&offer.validFrom>=input.effectiveFrom)) {
    throw new Error('匹配渠道已有同日或更晚的已发布版本，请先核对排期，不能用新原表覆盖已确认的未来版本');
  }
  const managedIds=new Set((await db.query<{price_draft_id:string}>('SELECT DISTINCT price_draft_id FROM quotation_v2.draft_release_links')).rows.map(row=>row.price_draft_id));
  const token=hash([input,head??null,incoming,previousRows,templates,[...managedIds].sort()]);
  return {incoming,previousRows,oldById,seriesId,head,templates,managedIds,items,summary,token,
    retainedExamples:previousRows.filter(row=>!used.has(row.id)).slice(0,20).map(row=>`${row.channel_hint} · ${row.proposed_data.destinationLabel}`)};
}

export async function previewUpdate(db:Database,input:QuoteUpdateInput,page=1):Promise<QuoteUpdatePreview> {
  const plan=await planUpdate(db,input);
  const order={ambiguous:0,changed:1,new:2,unchanged:3};
  const rows=plan.items.sort((a,b)=>order[a.kind]-order[b.kind] || a.id.localeCompare(b.id));
  return {token:plan.token,summary:plan.summary,items:rows.slice((page-1)*50,page*50),page,pageSize:50,retainedExamples:plan.retainedExamples};
}

export async function updateCandidates(db:Database,input:QuoteUpdateInput,draftId:string,q:string,page=1) {
  const plan=await planUpdate(db,input),draft=plan.incoming.find(row=>row.id===draftId);
  if(!draft)throw new Error('请选择本期原表中的报价记录');
  const term=normal(q);
  const candidates=plan.previousRows.filter(row=>providerKey(row)===providerKey(draft)&&row.country_hint===draft.country_hint&&row.mode_hint===draft.mode_hint
    &&row.proposed_data.currency===draft.proposed_data.currency&&row.proposed_data.billingBasis===draft.proposed_data.billingBasis
    &&normal(`${row.channel_hint} ${row.proposed_data.destinationLabel}`).includes(term));
  return {items:candidates.slice((page-1)*20,page*20).map(row=>({id:row.id,channel:row.channel_hint,destination:row.proposed_data.destinationLabel,prices:priceText(row)})),total:candidates.length,page,pageSize:20};
}

function inheritRules(draft:PriceDraftRecord,base:Offer,selection:{mode:TransportMode;country:string},effectiveFrom:string|null):Offer {
  const fresh=prepareOffer(draft,selection);
  const billing={...base.billing},q=draft.proposed_data;
  if(q.volumetricDivisor!=null) billing.volumetricDivisor=String(q.volumetricDivisor);
  if(q.minShipmentKg!=null && billing.basis==='kg') billing.minimumQuantity=String(q.minShipmentKg);
  if(q.minCbm!=null && billing.basis==='cbm') billing.minimumQuantity=String(q.minCbm);
  if(q.minPieceKg!=null) billing.minimumPieceKg=String(q.minPieceKg);
  if(q.densityConversionKgPerCbm!=null) billing.densityKgPerCbm=String(q.densityConversionKgPerCbm);
  return {...base,id:randomUUID(),status:'draft',name:fresh.name,tiers:fresh.tiers,targets:fresh.targets,
    billing,validFrom:effectiveFrom??fresh.validFrom,validTo:fresh.validTo,sourceKind:'workbook',
    reviewed:false,cargoReviewed:false,sourceDraftId:draft.id,sourceReady:true,versionLabel:draft.version_label??null,
    reviewReasons:[...new Set([...base.reviewReasons,'本期价格、计费规则、承运条件及附加费需对照新原表复核'])],
    notes:fresh.notes,transitText:fresh.transitText,
    sourceEvidence:[...fresh.sourceEvidence,...base.sourceEvidence].slice(0,200)};
}

function templateAt(offers:Offer[],asOf:string|null) {
  const sorted=offers.filter(o=>!asOf||!o.validFrom||o.validFrom<=asOf).sort((a,b)=>(b.revision??0)-(a.revision??0));
  const applicable=sorted.filter(o=>!asOf||!o.validTo||o.validTo>asOf);
  return applicable.find(o=>o.status==='published')??applicable[0]??sorted[0];
}

export async function prepareVersionOffer(db:Database,draft:PriceDraftRecord,selection:{mode:TransportMode;country:string}) {
  const period=(await db.query<{family_id:string}>('SELECT family_id FROM quotation_v2.price_periods WHERE draft_id=$1',[draft.id])).rows[0];
  if(period) {
    const family=(await db.query<{draft_id:string}>(`SELECT draft_id FROM quotation_v2.price_periods WHERE family_id=$1
      AND (valid_from IS NULL OR ($2::date IS NOT NULL AND valid_from<=$2::date))`,[period.family_id,draft.version_from??null])).rows.map(row=>row.draft_id);
    const base=templateAt((await getOffers(db)).filter(o=>o.sourceDraftId && family.includes(o.sourceDraftId) && o.mode===selection.mode && o.country===selection.country),draft.version_from??null);
    if(base?.status==='revoked') throw new Error('该渠道已撤销，不能通过新原表恢复使用');
    if(base) return inheritRules(draft,base,selection,draft.version_from??null);
  }
  return {...prepareOffer(draft,selection),validFrom:draft.version_from??draft.proposed_data.effectiveAt?.slice(0,10)??null,sourceReady:draft.pricing_state!=='pending'};
}

export async function activateUpdate(db:Database,input:QuoteUpdateInput,token:string) {
  return db.transaction(async tx=>{
    await tx.exec('LOCK TABLE quotation_v2.price_drafts IN SHARE ROW EXCLUSIVE MODE; LOCK TABLE quotation_v2.quote_updates IN EXCLUSIVE MODE');
    await tx.query('SELECT id FROM quotation_v2.channels ORDER BY id FOR UPDATE');
    const requestHash=hash(input);
    const existing=(await tx.query<{id:string;request_hash:string;summary:QuoteUpdatePreview['summary']}>('SELECT id,request_hash,summary FROM quotation_v2.quote_updates WHERE source_id=$1',[input.sourceId])).rows[0];
    if(existing) { if(existing.request_hash!==requestHash) throw new Error('这份原表已按另一组设置生效，不能重复修改');return {id:existing.id,summary:existing.summary,reused:true}; }
    const plan=await planUpdate(tx,input);
    if(plan.token!==token) throw new Error('报价或规则已变化，请重新预览后确认生效');
    if(plan.summary.ambiguous) throw new Error('存在无法唯一匹配的渠道，请逐条确认关联或明确选择新增渠道');
    const updateId=randomUUID();
    await tx.query(`INSERT INTO quotation_v2.quote_updates(id,source_id,previous_source_id,series_id,label,effective_from,request_hash,summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[updateId,input.sourceId,input.previousSourceId,plan.seriesId,input.label,input.effectiveFrom,requestHash,JSON.stringify(plan.summary)]);
    if(!plan.head && plan.previousRows.length) await tx.query(`INSERT INTO quotation_v2.price_periods(draft_id,family_id,series_id)
      SELECT value,value,$2 FROM jsonb_array_elements_text($1::jsonb) ON CONFLICT(draft_id) DO NOTHING`,[JSON.stringify(plan.previousRows.map(row=>row.id)),plan.seriesId]);
    const replaced=plan.items.map(row=>row.previousDraftId).filter(Boolean);
    await tx.query('UPDATE quotation_v2.price_periods SET valid_to=$2 WHERE draft_id=ANY($1::text[]) AND valid_to IS NULL',[replaced,input.effectiveFrom]);
    const rows=plan.items.map(row=>({id:row.id,family:row.previousDraftId?(plan.oldById.get(row.previousDraftId)!.family_id??row.previousDraftId):row.id}));
    await tx.query(`INSERT INTO quotation_v2.price_periods(draft_id,family_id,series_id,update_id,valid_from)
      SELECT x.id,x.family,$2,$3,$4::date FROM jsonb_to_recordset($1::jsonb) AS x(id text,family text)`,[JSON.stringify(rows),plan.seriesId,updateId,input.effectiveFrom]);
    await tx.query("UPDATE quotation_v2.source_files SET pricing_state='versioned' WHERE id=$1",[input.sourceId]);
    // Carry managed rules forward as reviewable drafts, never silently publish them.
    let inherited=0;
    for(const row of plan.items) {
      if(!row.previousDraftId) continue;
      const offers=plan.templates.filter(o=>o.sourceDraftId===row.previousDraftId);
      const before=new Date(new Date(input.effectiveFrom+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10);
      const bases=[...new Set(offers.map(o=>o.channelId))].map(channel=>templateAt(offers.filter(o=>o.channelId===channel),before)).filter((o):o is Offer=>Boolean(o)&&o!.status!=='revoked');
      if(plan.oldById.get(row.previousDraftId)?.status==='excluded' || (!bases.length && plan.managedIds.has(row.previousDraftId))) {
        await tx.query("UPDATE quotation_v2.price_drafts SET status='excluded' WHERE id=$1",[row.id]);continue;
      }
      if(!bases.length) continue;
      const draft=(await getPriceDraft(tx,row.id))!;
      for(const base of bases) {await saveDraft(tx,inheritRules(draft,base,{mode:base.mode,country:base.country},input.effectiveFrom),row.id,true);inherited++;}
    }
    await tx.query('INSERT INTO quotation_v2.audit_logs(action,entity_id,detail) VALUES($1,$2,$3)', ['quote_update_activated',updateId,JSON.stringify({...input,summary:plan.summary,inherited})]);
    return {id:updateId,summary:plan.summary,inherited,reused:false};
  });
}
