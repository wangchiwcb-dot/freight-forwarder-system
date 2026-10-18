import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Decimal from 'decimal.js';
import type { Quote } from '../../src/domain/types.ts';
import { TABLE_ORDER } from './import-history.ts';
import { digest, money, taxTerms, cargoRules, sqlLiteral } from './rules.ts';

export function verifyHistory(databasePath = '.local/d1-import/freight-quotes.sqlite', output = '.local/d1-import') {
  const db = new DatabaseSync(databasePath, {readOnly:true});
  const failures: string[] = [];
  const assert = (ok: unknown, label: string) => { if (!ok) failures.push(label); };
  const integrity = db.prepare('PRAGMA integrity_check').all();
  assert(integrity.length===1 && integrity[0].integrity_check==='ok','SQLite integrity');
  assert(db.prepare('PRAGMA foreign_key_check').all().length===0,'Foreign keys');
  const tiers = db.prepare('SELECT * FROM quote_tiers WHERE quote_version_id=? ORDER BY ordinal');
  const targets = db.prepare('SELECT * FROM quote_targets WHERE quote_version_id=?');
  const cargoStatement = db.prepare('SELECT * FROM quote_cargo_types WHERE quote_version_id=? ORDER BY cargo_type');
  const charges = db.prepare('SELECT * FROM quote_charge_rules WHERE quote_version_id=?');
  let checkedQuotes=0, checkedTiers=0, fixedFees=0, totalMicros=0n;
  const traversal = db.prepare(`SELECT r.*,v.*,i.country_code,i.origin,i.destination_label,i.billing_basis,i.delivery_type,
    c.name AS channel_name,c.provider_id,c.transport_mode,p.name AS provider_name,p.is_own,
    rules.notes_json,rules.calculation_json FROM import_rows r
    JOIN quote_versions v ON v.id=r.quote_version_id JOIN quote_items i ON i.id=v.quote_item_id
    JOIN channels c ON c.id=i.channel_id JOIN providers p ON p.id=c.provider_id JOIN quote_rules rules ON rules.id=v.rule_id`);
  for (const row of traversal.all()) {
    const original = {...JSON.parse(String(row.source_quote_json)), notes:JSON.parse(String(row.notes_json))} as Quote;
    const prefix = `${original.source.fileName}/${original.source.sheet}/${original.id}`;
    assert(digest(original)===row.content_hash,`${prefix}: complete source roundtrip`);
    const fields: Array<[unknown,unknown,string]> = [[original.countryCode,row.country_code,'country'],[original.origin,row.origin,'origin'],
      [original.destinationLabel,row.destination_label,'destination'],[original.billingBasis,row.billing_basis,'billing'],
      [original.delivery,row.delivery_type,'delivery'],[original.channelName,row.channel_name,'channel'],
      [original.providerId,row.provider_id,'provider'],[original.providerName,row.provider_name,'provider name'],
      [original.isOwn?1:0,row.is_own,'own'],[original.mode,row.transport_mode,'mode'],
      [original.currency,row.currency,'currency'],[original.currencyEvidence,row.currency_evidence,'currency evidence'],
      [original.priceDate,row.quoted_on,'quote date'],[original.effectiveAt,row.valid_from,'effective date'],
      [original.dateKind,row.date_evidence,'date evidence'],[original.transitText,row.transit_text,'transit'],
      [original.status,row.legacy_status,'status'],[JSON.stringify(original.reviewReasons),row.review_reasons_json,'review reasons']];
    for(const [expected,actual,label] of fields) {
      const identityLabel = ['destination','origin','channel'].includes(label);
      const matches = identityLabel && typeof expected==='string' && typeof actual==='string'
        ? expected.normalize('NFKC').trim()===actual.normalize('NFKC').trim() : expected===actual;
      assert(matches,`${prefix}: ${label}`);
    }
    const calculation=JSON.parse(String(row.calculation_json));
    for(const key of ['volumetricDivisor','minShipmentKg','minPieceKg','minCbm','maxKgPerCbm','densityConversionKgPerCbm','volumeEquivalentKgPerCbm'] as const)
      assert((original[key]??null)===calculation[key],`${prefix}: ${key}`);
    assert(JSON.stringify(original.reliability)===JSON.stringify(calculation.reliability),`${prefix}: reliability`);
    const storedTiers=tiers.all(row.id);
    assert(storedTiers.length===original.tiers.length,`${prefix}: tier count`);
    for(const [ordinal,tier] of original.tiers.entries()) {
      const actual=storedTiers[ordinal]; if(!actual)continue;
      const sameQuantity=(a:unknown,b:unknown)=>a==null?b==null:b!=null&&new Decimal(String(a)).eq(String(b));
      assert(sameQuantity(tier.min,actual.min_quantity)&&sameQuantity(tier.max,actual.max_quantity),`${prefix}: tier bounds ${ordinal}`);
      assert(actual.min_inclusive===(tier.minInclusive===false?0:1)&&actual.max_inclusive===(tier.maxInclusive===false?0:1),`${prefix}: tier endpoints ${ordinal}`);
      const amount=money(tier.price);
      assert(actual.price_micros===amount.micros&&actual.price_decimal===amount.decimal,`${prefix}: price ${ordinal}`);
      assert(actual.price_status===tier.status&&actual.source_cell===tier.sourceCell&&actual.label===tier.label,`${prefix}: tier metadata ${ordinal}`);
      if(amount.micros!=null)totalMicros+=BigInt(amount.micros);
      checkedTiers++;
    }
    const expectedTargets=[...original.warehouseCodes.map(v=>['warehouse',v,null]),...original.postalPrefixes.map(v=>['postal_prefix',v,null]),
      ...(original.postalCodes??[]).map(v=>['postal_code',v,null]),...(original.postalRanges??[]).map(v=>['postal_range',v.start,v.end])];
    if(!expectedTargets.length)expectedTargets.push(['label',original.destinationLabel,null]);
    const sorted=(items:unknown[])=>JSON.stringify([...new Set(items.map(v=>JSON.stringify(v)))].sort());
    assert(sorted(expectedTargets)===sorted(targets.all(row.id).map(t=>[t.target_kind,t.value,t.range_end])),`${prefix}: destination coverage`);
    if(row.semantic_parser_version!=='quote-semantics/2'){
      const expectedCargo=cargoRules(original);
      assert(sorted(expectedCargo.map(c=>[c.type,c.acceptance,c.evidenceKind]))===sorted(cargoStatement.all(row.id).map(c=>[c.cargo_type,c.acceptance,c.evidence_kind])),`${prefix}: cargo rules`);
      const tax=taxTerms(original.channelName);
      assert(row.tax_mode===tax.mode&&row.duty_inclusion===tax.duty&&row.vat_inclusion===tax.vat&&row.tax_settlement===tax.settlement,`${prefix}: tax mapping`);
    }else{
      assert(['explicit','business_default','mixed'].includes(String(row.tax_evidence_kind)),`${prefix}: semantic tax evidence`);
      assert(JSON.parse(String(row.semantic_evidence_json)).version==='quote-semantics/2',`${prefix}: semantic provenance`);
    }
    const fixed=original.tiers.filter(t=>t.fixedFee!=null).map(t=>money(t.fixedFee).micros);
    const originalFees=charges.all(row.id).filter(c=>c.fee_code==='legacy_fixed_fee');
    assert(fixed.length===originalFees.length,`${prefix}: fixed fee count`);
    assert(sorted(fixed)===sorted(originalFees.map(c=>c.amount_micros)),`${prefix}: fixed fees`);
    fixedFees+=fixed.length;
    assert(row.reconciliation_status==='matched',`${prefix}: source price reconciliation`);
    checkedQuotes++;
  }
  const availableTables=TABLE_ORDER.filter(t=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const counts=Object.fromEntries(availableTables.map(t=>[t,(db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as {n:number}).n]));
  assert(checkedQuotes===counts.quote_versions&&checkedTiers===counts.quote_tiers,'No missing/orphan versions or tiers');
  const batchMismatches=db.prepare(`SELECT b.id FROM import_batches b WHERE b.expected_quotes<>(SELECT count(*) FROM quote_versions v WHERE v.batch_id=b.id)`).all();
  assert(!batchMismatches.length,'Batch quote counts');
  const report={verifiedAt:new Date().toISOString(),databasePath:path.resolve(databasePath),passed:failures.length===0,
    checkedQuotes,checkedTiers,fixedFees,totalPriceMicros:totalMicros.toString(),counts,failures};
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'verification-report.json'),JSON.stringify(report,null,2));
  // One result row per table; these queries do not download commercial data.
  const remoteQueries=availableTables.map(t=>`SELECT ${sqlLiteral(t)} AS table_name,count(*) AS row_count FROM ${t}`).join(' UNION ALL ');
  fs.writeFileSync(path.join(output,'verify-counts.sql'),remoteQueries+';\n');
  db.close();
  if(failures.length)throw new Error(`Verification failed (${failures.length}): ${failures.slice(0,12).join('; ')}`);
  console.log(JSON.stringify(report));
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)verifyHistory(process.argv[2],process.argv[3]);
