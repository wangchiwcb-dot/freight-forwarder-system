import type { SearchRequest } from '../src/api/contracts';
import type { SearchResponse } from '../src/domain/types';
import { searchQuotes } from '../src/domain/search';
import { rows, type Database } from './db';
import { deliverySql, getQuotes, joins, resolveSnapshot, visible } from './repository';

// Filter and rank before hydrating notes/evidence. Only the requested page crosses
// the D1 boundary; counts and ranking use the entire selected, published dataset.
export function searchQuery(input: SearchRequest, snapshotId: string, now = new Date()) {
  const c = input.criteria;
  const destination = c.destination.trim().toUpperCase();
  const postal = /^\d{5}-\d{4}$/.test(destination) ? destination.slice(0,5) : destination.replace(/\s/g,'');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const cutoff = c.asOf === today ? now.toISOString() : `${c.asOf}T23:59:59.999+08:00`;
  const args = [snapshotId, c.country,c.mode,c.providerId,c.onlyOwn ? 1 : 0,c.cargo,c.delivery ?? 'all',
    (c.origin ?? '').trim().toUpperCase(),destination,postal,!/\d/.test(destination) && destination.length >= 2 ? 1 : 0,
    c.actualKg,c.volumeCbm,c.pieces,c.asOf,cutoff,c.cargoShape,c.includePending ? 1 : 0];
  const calc = (key: string) => `json_extract(r.calculation_json,'$.${key}')`;
  const dateInstant = (value: string) => `julianday(CASE WHEN substr(${value},-1) IN ('Z','z') OR substr(${value},-6,1) IN ('+','-')
    THEN ${value} ELSE replace(${value},' ','T')||'+08:00' END)`;
  const targetHit = `(t.target_kind='warehouse' AND upper(trim(t.value))=x.destination)
    OR (t.target_kind='postal_prefix' AND substr(x.postal,1,length(replace(upper(t.value),' ','')))=replace(upper(t.value),' ',''))
    OR (t.target_kind='postal_code' AND replace(upper(t.value),' ','')=x.postal)
    OR (t.target_kind='postal_range' AND x.postal NOT GLOB '*[^0-9]*' AND t.value NOT GLOB '*[^0-9]*'
      AND t.range_end NOT GLOB '*[^0-9]*' AND length(x.postal)=length(t.value) AND length(t.value)=length(t.range_end)
      AND x.postal>=t.value AND x.postal<=t.range_end)`;
  const order = {
    cost: `coalesce(currency,'UNKNOWN'),eligible DESC,(cost IS NULL),cost,id`,
    unit: `coalesce(currency,'UNKNOWN')||':'||billing_basis,(tier_price IS NULL),tier_price,eligible DESC,id`,
    updated: `substr(coalesce(valid_from,quoted_on,''),1,10) DESC,eligible DESC,id`,
    reliability: `reliability_rank,eligible DESC,id`,
  }[c.sort];
  const sql = `WITH x AS (SELECT ? snapshot,? country,? mode,? provider,? own,? cargo,? delivery,? origin,
    ? destination,? postal,? city,? kg,? cbm,? pieces,? as_of,? cutoff,? shape,? pending),
  base AS MATERIALIZED (
    SELECT v.id,v.currency,v.currency_evidence,v.valid_from,v.quoted_on,i.billing_basis,
      ${calc('volumetricDivisor')} divisor,${calc('minShipmentKg')} min_kg,${calc('minPieceKg')} min_piece,
      ${calc('minCbm')} min_cbm,${calc('maxKgPerCbm')} max_density,${calc('densityConversionKgPerCbm')} conversion,
      CASE ${calc('reliability.level')} WHEN 'verified' THEN 0 WHEN 'concern' THEN 1 ELSE 2 END reliability_rank,
      coalesce((SELECT acceptance FROM quote_cargo_types g WHERE g.quote_version_id=v.id AND g.cargo_type=x.cargo),'unknown') cargo_state,
      CASE WHEN x.origin='' OR instr(upper(i.origin),x.origin)>0 OR i.origin='全国' THEN 1
        WHEN i.origin='' OR instr(i.origin,'按原表')>0 OR instr(i.origin,'待确认')>0 OR instr(i.origin,'不详')>0 OR instr(i.origin,'未知')>0 THEN 0 ELSE -1 END origin_state,
      CASE WHEN x.delivery='all' OR ${deliverySql} IN (x.delivery,'all') THEN 1 WHEN ${deliverySql}='unknown' THEN 0 ELSE -1 END delivery_state,
      CASE WHEN x.destination='' THEN 1
        WHEN EXISTS(SELECT 1 FROM quote_targets t WHERE t.quote_version_id=v.id AND t.effect='exclude' AND (${targetHit})) THEN -1
        WHEN EXISTS(SELECT 1 FROM quote_targets t WHERE t.quote_version_id=v.id AND t.effect='include' AND (${targetHit})) THEN 1
        WHEN x.city=1 AND instr(upper(i.destination_label),x.destination)>0 THEN 1
        WHEN NOT EXISTS(SELECT 1 FROM quote_targets t WHERE t.quote_version_id=v.id AND t.effect='include' AND t.target_kind<>'label') THEN 0 ELSE -1 END destination_state,
      (i.country_code='EU' AND x.country NOT IN ('EU','ALL')) unknown_country,
      (v.legacy_status<>'reference' OR v.pricing_readiness IN ('suspended','needs_review')) status_blocked,
      CASE WHEN v.date_evidence='filename' AND v.valid_from IS NULL THEN 0
        WHEN length(coalesce(v.valid_from,v.quoted_on,''))>10 THEN ${dateInstant('coalesce(v.valid_from,v.quoted_on)')}>julianday(x.cutoff)
        ELSE coalesce(v.valid_from,v.quoted_on,'')>x.as_of END future,
      CASE WHEN v.valid_to IS NULL THEN 0 WHEN length(v.valid_to)=10 THEN v.valid_to<=x.as_of
        ELSE ${dateInstant('v.valid_to')}<=julianday(x.cutoff) END expired,
      EXISTS(SELECT 1 FROM quote_charge_rules f WHERE f.quote_version_id=v.id AND f.fee_code='legacy_fixed_fee') has_fixed
    ${joins} JOIN snapshot_batches sb ON sb.batch_id=b.id JOIN quote_rules r ON r.id=v.rule_id CROSS JOIN x
    WHERE ${visible} AND sb.snapshot_id=x.snapshot
      AND ${c.country==='ALL'?'1':['DE','FR','IT','ES','PL','CZ'].includes(c.country)?"i.country_code IN (x.country,'EU')":'i.country_code=x.country'}
      AND ${c.mode==='all'?'1':'c.transport_mode=x.mode'} AND ${c.providerId?'p.id=x.provider':'1'} AND ${c.onlyOwn?'p.is_own=1':'1'}
  ), quantities AS MATERIALIZED (
    SELECT b.*,
      CASE WHEN billing_basis='kg' THEN CASE WHEN x.kg IS NULL OR (has_fixed=1 AND coalesce(x.pieces,0)<>1) THEN NULL
        ELSE max(x.kg,coalesce(x.cbm*1000000.0/nullif(divisor,0),0),coalesce(min_piece*x.pieces,0),coalesce(min_kg,0)) END
      WHEN billing_basis='cbm' THEN CASE WHEN x.cbm IS NULL OR ((conversion IS NOT NULL OR max_density IS NOT NULL) AND x.kg IS NULL)
        OR (max_density IS NOT NULL AND x.kg/x.cbm>max_density) THEN NULL
        ELSE max(x.cbm,coalesce(x.kg/nullif(conversion,0),0),coalesce(min_cbm,0)) END
      WHEN billing_basis='parcel' THEN x.pieces ELSE NULL END quantity,
      CASE WHEN billing_basis='cbm' AND max_density IS NOT NULL AND x.kg IS NOT NULL AND x.cbm IS NOT NULL
        AND x.kg/x.cbm>max_density THEN 1 ELSE 0 END density_blocked
    FROM base b CROSS JOIN x WHERE cargo_state<>'forbidden' AND origin_state>=0 AND delivery_state>=0 AND destination_state>=0
      AND (x.shape='all' OR x.kg IS NULL OR x.cbm IS NULL OR billing_basis<>'kg' OR divisor IS NULL OR divisor<=0
        OR (x.shape='dense' AND x.kg>=x.cbm*1000000.0/divisor) OR (x.shape='bulky' AND x.kg<x.cbm*1000000.0/divisor))
  ), matched AS MATERIALIZED (
    SELECT q.*,count(t.id) tier_count,CASE WHEN count(t.id)=1 THEN min(t.id) END tier_id,
      CASE WHEN count(t.id)=1 THEN min(t.price_decimal*1.0) END tier_price,min(t.price_status) tier_status
    FROM quantities q LEFT JOIN quote_tiers t ON t.quote_version_id=q.id
      AND (t.min_quantity IS NOT NULL OR t.max_quantity IS NOT NULL)
      AND (t.min_quantity IS NULL OR (t.min_inclusive=1 AND q.quantity>=t.min_quantity*1.0) OR (t.min_inclusive=0 AND q.quantity>t.min_quantity*1.0))
      AND (t.max_quantity IS NULL OR (t.max_inclusive=1 AND q.quantity<=t.max_quantity*1.0) OR (t.max_inclusive=0 AND q.quantity<t.max_quantity*1.0))
    GROUP BY q.id
  ), eligibility AS MATERIALIZED (
    SELECT m.*,f.amount_decimal*1.0 fixed_fee,f.charge_basis fixed_basis,
      (cargo_state='allowed' AND origin_state=1 AND delivery_state=1 AND destination_state=1 AND unknown_country=0
        AND status_blocked=0 AND future=0 AND expired=0 AND density_blocked=0
        AND (quantity IS NULL OR (tier_count=1 AND tier_status='priced' AND tier_price>=0
          AND (f.id IS NULL OR (f.review_status='verified' AND f.charge_basis IN ('piece','shipment')
            AND json_extract(f.conditions_json,'$.delivery_zone') IS NULL AND f.currency=m.currency
            AND (f.charge_basis<>'piece' OR x.pieces IS NOT NULL)))))) eligible
    FROM matched m CROSS JOIN x LEFT JOIN quote_charge_rules f ON f.quote_version_id=m.id AND f.tier_id=m.tier_id AND f.fee_code='legacy_fixed_fee'
  ), results AS MATERIALIZED (
    SELECT e.*,CASE WHEN eligible=1 AND quantity IS NOT NULL AND currency IS NOT NULL AND currency_evidence<>'unconfirmed'
      THEN round(tier_price*quantity+coalesce(fixed_fee,0)*CASE WHEN fixed_basis='piece' THEN x.pieces ELSE 1 END,6) ELSE NULL END cost
    FROM eligibility e CROSS JOIN x WHERE x.pending=1 OR eligible=1
  ), page AS (SELECT id,cost,eligible FROM results ORDER BY ${order} LIMIT ? OFFSET ?)
  SELECT count(*) total,coalesce(sum(cost IS NOT NULL),0) computedCount,coalesce(sum(eligible=0),0) pendingCount,
    (SELECT json_group_array(json_object('id',id,'cost',cost,'eligible',eligible)) FROM page) items FROM results`;
  return { sql, args: [...args,input.pageSize,(input.page-1)*input.pageSize] };
}

export async function search(db: Database, request: SearchRequest): Promise<SearchResponse> {
  const snapshot = await resolveSnapshot(db, request.snapshotId);
  const query = searchQuery(request, snapshot.id);
  const [result] = await rows(db, query.sql, query.args);
  const selected: { id: string; cost: number | null; eligible: number }[] = JSON.parse(result.items);
  const quotes = await getQuotes(db, selected.map(item => item.id));
  const evaluated = searchQuotes(quotes, request.criteria);
  const byId = new Map(evaluated.map(item => [item.quote.id,item]));
  const items = selected.map(row => {
    const item = byId.get(row.id);
    // Fail closed if query ranking and the decimal business calculator diverge.
    if (!item || item.eligible !== !!row.eligible || (row.cost === null) !== (item.estimatedCost === null) ||
      (row.cost !== null && Math.abs(row.cost - item.estimatedCost!) > 0.0000011)) {
      throw new Error(`Search/calculation mismatch for ${row.id}`);
    }
    return item;
  });
  return { items, total: result.total, computedCount: result.computedCount, pendingCount: result.pendingCount,
    page: request.page, pageSize: request.pageSize, snapshotId: snapshot.id };
}
