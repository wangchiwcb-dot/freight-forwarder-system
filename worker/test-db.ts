import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Database, Statement } from './db';

export function adapter(sqlite: DatabaseSync): Database {
  return { prepare(sql: string): Statement {
    let args: any[] = [];
    return { bind(...values) { args = values; return this; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...args) as T[] }; },
      async first<T>() { return (sqlite.prepare(sql).get(...args) ?? null) as T | null; },
    };
  } };
}
export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_quote_history.sql','0002_semantic_refinement.sql']) sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const put = (table: string, row: Record<string, any>) => {
    const keys = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  put('providers',{id:'own',name:'测试代理',is_own:1});
  put('channels',{id:'channel',provider_id:'own',name:'测试海运',transport_mode:'sea'});
  put('source_files',{id:'source',sha256:'test',original_name:'测试.xlsx',local_path:'PRIVATE_PATH_MUST_NOT_LEAK'});
  for (const id of ['current','historical']) put('dataset_snapshots',{id,name:id,source_kind:id==='current'?'published_json':'historical_excel',
    manifest_hash:id,imported_at:'2026-10-01',observed_date:id==='current'?'2026-10-01':'2026-09-01',source_version:id});
  const rules = { volumetricDivisor:6000,minShipmentKg:null,minPieceKg:null,minCbm:null,maxKgPerCbm:null,
    densityConversionKgPerCbm:null,volumeEquivalentKgPerCbm:null,reliability:{level:'unknown',note:''} };
  function add(id: string, options: { country?:string; basis?:string; price?:number; cargo?:string; acceptance?:string;
    status?:string; date?:string; dateKind?:string; from?:string|null; to?:string|null; rules?:Record<string,unknown>;
    snapshot?:string; item?:string; fixed?:number; confirmed?:boolean; zone?:string; postal?:string; delivery?:string } = {}) {
    const batch = `batch_${id}`; const item = options.item ?? `item_${id}`;
    put('import_batches',{id:batch,source_file_id:'source',provider_id:'own',parser_version:'test',idempotency_key:id,
      original_name:`${id}.xlsx`,status:options.status ?? 'published',expected_quotes:1,imported_at:'2026-10-18',coverage_json:'{"status":"partial","warnings":["测试覆盖"]}'});
    put('snapshot_batches',{snapshot_id:options.snapshot ?? 'current',batch_id:batch});
    if (!sqlite.prepare('SELECT id FROM quote_items WHERE id=?').get(item)) put('quote_items',{id:item,channel_id:'channel',business_key:item,
      origin:'深圳',country_code:options.country ?? 'US',destination_label:'洛杉矶',delivery_type:options.delivery ?? 'all',
      billing_basis:options.basis ?? 'kg',currency:'CNY',tax_variant:'included',cargo_variant:'general'});
    put('quote_rules',{id:`rule_${id}`,content_hash:id,calculation_json:JSON.stringify({...rules,...options.rules}),notes_json:'["未结构化附加费需确认"]'});
    put('quote_versions',{id,quote_item_id:item,batch_id:batch,legacy_quote_id:id,content_hash:id,rule_id:`rule_${id}`,
      quoted_on:options.date ?? '2026-10-01',valid_from:options.from ?? null,valid_to:options.to ?? null,date_evidence:options.dateKind ?? 'explicit',
      tax_mode:'included',tax_evidence:'业务默认包税',tax_evidence_kind:'business_default',currency:'CNY',currency_evidence:'explicit',
      transit_text:'20天',legacy_status:'reference',pricing_readiness:'base_only',review_reasons_json:'[]'});
    put('quote_tiers',{id:`tier_${id}`,quote_version_id:id,ordinal:0,label:'0以上',min_quantity:'0',max_quantity:null,
      min_inclusive:1,max_inclusive:1,price_micros:Math.round((options.price ?? 10)*1e6),price_decimal:String(options.price ?? 10),currency:'CNY',price_status:'priced',source_cell:'B2'});
    put('quote_targets',{id:`target_${id}`,quote_version_id:id,country_code:options.country ?? 'US',target_kind:'postal_prefix',value:options.postal ?? '09'});
    put('quote_cargo_types',{quote_version_id:id,cargo_type:options.cargo ?? 'general',acceptance:options.acceptance ?? 'allowed',evidence_kind:'explicit',evidence_text:'原表依据',conditions_json:'[]'});
    put('import_rows',{id:`row_${id}`,batch_id:batch,quote_version_id:id,legacy_quote_id:id,sheet_name:'报价',cells_json:'["B2"]',hidden:0,source_quote_json:'{}',reconciliation_status:'matched'});
    if (options.fixed != null) put('quote_charge_rules',{id:`fee_${id}`,quote_version_id:id,tier_id:`tier_${id}`,fee_code:'legacy_fixed_fee',label:'处理费',calculation_type:'fixed',charge_basis:'shipment',
      amount_micros:Math.round(options.fixed*1e6),amount_decimal:String(options.fixed),currency:'CNY',review_status:options.confirmed===false?'needs_review':'verified',
      evidence_text:'每票',conditions_json:JSON.stringify(options.zone ? {delivery_zone:options.zone} : {})});
  }
  add('kg'); add('cbm',{basis:'cbm',price:600,rules:{densityConversionKgPerCbm:500,minCbm:0.1}});
  add('pending',{acceptance:'unknown'}); add('forbidden',{acceptance:'forbidden'}); add('conditional',{acceptance:'conditional'});
  add('future',{date:'2026-11-01'}); add('expired',{to:'2026-10-01'});
  add('old',{snapshot:'historical',item:'item_kg',date:'2026-09-01',price:8});
  add('staged',{status:'staged'}); add('archived',{status:'archived'}); add('revoked',{status:'revoked'});
  add('eu',{country:'EU'}); add('gb',{country:'GB'});
  add('fee',{price:0.1,fixed:0.2}); add('unverifiedfee',{fixed:20,confirmed:false}); add('zonefee',{fixed:20,zone:'一区'});
  return { sqlite, db:adapter(sqlite), add, put };
}
