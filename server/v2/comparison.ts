import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import { getOffers } from './repository';
import { calculateOffers, ENGINE_VERSION } from '../../src/domain/v2/pricing';
import { estimateSource, fromRuleResult, rankComparison, comparisonSummary } from '../../src/domain/v2/comparison';
import type { ComparisonInput, ComparisonItem, ComparisonRun } from '../../src/domain/v2/comparison-contracts';
import type { PriceDraftRecord } from '../../src/domain/v2/review-contracts';
import { pricePeriodFields, pricePeriodJoins, visiblePriceSql } from './periods';

export async function createComparison(db:Database,input:ComparisonInput):Promise<string> {
  return db.transaction(async tx=>{
    // A quote update may commit while candidates are loading. Keep every read
    // and the saved result on one database snapshot, including rule versions.
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return createComparisonSnapshot(tx,input);
  });
}

async function createComparisonSnapshot(db:Database,input:ComparisonInput):Promise<string> {
  const {request,options}=input;
  const selected=options.selectedDraftIds;
  // Read every candidate before ranking. LIMIT belongs only to the saved result page.
  const drafts=(await db.query<PriceDraftRecord>(`SELECT d.id,d.source_id,s.original_name AS source_name,
    d.provider_hint,d.channel_hint,d.country_hint,d.mode_hint,d.status,d.proposed_data-'notes' AS proposed_data,${pricePeriodFields}
    FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id
    ${pricePeriodJoins}
    WHERE d.country_hint=$1 AND d.mode_hint=ANY($2::text[]) AND ($3::text[]='{}' OR d.id=ANY($3::text[])) AND ${visiblePriceSql('$4')}`,
    [request.country,request.modes,selected,request.asOf])).rows;
  const links=(await db.query<{price_draft_id:string;channel_id:string;release_id:string;revision:number}>(`SELECT l.price_draft_id,r.channel_id,r.id AS release_id,r.revision
    FROM quotation_v2.draft_release_links l JOIN quotation_v2.channel_releases r ON r.id=l.release_id ORDER BY r.revision DESC`)).rows;
  const versions=(await db.query<{id:string;revision:number}>('SELECT id,revision FROM quotation_v2.channel_releases')).rows;
  const revision=new Map(versions.map(row=>[row.id,row.revision]));
  const offers=(await getOffers(db,{country:request.country,modes:request.modes})).filter(offer=>offer.sourceKind!=='example');
  const managed=new Set(links.map(link=>link.price_draft_id));
  const byId=new Map(drafts.map(draft=>[draft.id,draft]));
  const chosen=offers.filter(offer=>!selected.length||links.some(link=>link.channel_id===offer.channelId&&selected.includes(link.price_draft_id)));
  const channelIds=[...new Set(chosen.map(offer=>offer.channelId))];
  const active=channelIds.flatMap(channelId=>{
    const group=chosen.filter(offer=>offer.channelId===channelId).sort((a,b)=>(revision.get(b.id)??0)-(revision.get(a.id)??0));
    const applicable=group.filter(offer=>offer.sourceReady!==false&&(!offer.validFrom||offer.validFrom<=request.asOf)&&(!offer.validTo||offer.validTo>request.asOf));
    const selected=applicable.find(offer=>offer.status==='published')??applicable[0];
    return selected?[selected]:[];
  });
  const cache=new Map();
  const rows:ComparisonItem[]=drafts.filter(draft=>!managed.has(draft.id)).map(draft=>estimateSource(draft,request,options,cache));
  const missing=active.map(offer=>offer.sourceDraftId).filter((value):value is string=>Boolean(value)&&!byId.has(value!));
  if(missing.length) {
    const linked=(await db.query<PriceDraftRecord>(`SELECT d.*,s.original_name AS source_name,${pricePeriodFields}
      FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id ${pricePeriodJoins} WHERE d.id=ANY($1::text[])`,[missing])).rows;
    for(const draft of linked)byId.set(draft.id,draft);
  }
  for (const result of calculateOffers(active,{...request,includeExamples:false,trialBilling:null})) {
    rows.push(fromRuleResult(result,result.offer.sourceDraftId?byId.get(result.offer.sourceDraftId)??null:null));
  }
  const ranked=rankComparison(rows),summary=comparisonSummary(ranked,selected.length),runId=randomUUID();
    await db.query(`INSERT INTO quotation_v2.comparison_runs(id,request,options,summary,engine_version,supersedes) VALUES($1,$2,$3,$4,$5,$6)`,
      [runId,JSON.stringify({...request,includeExamples:false,trialBilling:null}),JSON.stringify(options),JSON.stringify(summary),ENGINE_VERSION,input.supersedes]);
    // A batch avoids one network round trip per source record.
    for(let start=0;start<ranked.length;start+=200) await db.query(`INSERT INTO quotation_v2.comparison_results(run_id,ordinal,result)
      SELECT $1,$2::integer+ordinality::integer,value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY`,
      [runId,start,JSON.stringify(ranked.slice(start,start+200))]);
  return runId;
}

export async function loadComparison(db:Database,id:string,page=1,pageSize=15,showUnavailable=false):Promise<ComparisonRun|null> {
  const run=(await db.query<any>(`SELECT id,request,options,summary,engine_version AS "engineVersion",supersedes FROM quotation_v2.comparison_runs WHERE id=$1`,[id])).rows[0];
  if(!run) return null;
  const filter=showUnavailable?'':` AND result->>'status'<>'unavailable'`;
  const total=(await db.query<{count:number}>(`SELECT count(*)::int AS count FROM quotation_v2.comparison_results WHERE run_id=$1${filter}`,[id])).rows[0].count;
  const rows=(await db.query<{result:ComparisonItem}>(`SELECT result FROM quotation_v2.comparison_results WHERE run_id=$1${filter} ORDER BY ordinal LIMIT $2 OFFSET $3`,[id,pageSize,(page-1)*pageSize])).rows;
  return {...run,total,page,pageSize,items:rows.map(row=>row.result)};
}
