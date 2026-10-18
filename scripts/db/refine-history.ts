import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Quote } from '../../src/domain/types.ts';
import { digest,idFor,money } from './rules.ts';
import { SEMANTIC_VERSION,TAX_POLICY,SheetContext,resolveTax,summarizeTax,resolveCargo,scopedFees } from './semantics.ts';
import type { Sheet,Evidence } from './semantics.ts';

type Row=Record<string,string|number|null>;
const read=<T>(file:string):T=>JSON.parse(fs.readFileSync(file,'utf8'));
export function sourceSheets(){
  const manifest=read<{snapshots:{extract:string}[]}>('.local/history/manifest.json');
  const sources=new Map<string,{name:string;sheets:Sheet[]}>();
  for(const file of ['analysis/latest-extract.json',...manifest.snapshots.map(s=>s.extract)]){
    for(const source of read<{files:{sha256:string;name:string;sheets:Sheet[]}[]}>(file).files)
      if(!sources.has(source.sha256))sources.set(source.sha256,source);
  }
  return sources;
}

export function refineHistory(databasePath:string,output:string){
  fs.mkdirSync(output,{recursive:true});
  const db=new DatabaseSync(databasePath);
  if(!db.prepare('PRAGMA table_info(quote_versions)').all().some(c=>c.name==='semantic_parser_version'))
    db.exec(fs.readFileSync('migrations/0002_semantic_refinement.sql','utf8'));
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_quote_version ON import_issues(quote_version_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_review_task ON import_issues(review_task_id); CREATE INDEX IF NOT EXISTS idx_charge_targets_rule ON charge_rule_targets(charge_rule_id);');
  const now=new Date().toISOString(),sources=sourceSheets();
  const prepared=new Map<string,ReturnType<DatabaseSync['prepare']>>();
  const put=(table:string,row:Row,conflict='id')=>{
    const keys=Object.keys(row),pk=conflict.split(',');
    const sql=`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')}) ON CONFLICT(${conflict}) DO UPDATE SET ${keys.filter(k=>!pk.includes(k)).map(k=>`${k}=excluded.${k}`).join(',')}`;
    if(!prepared.has(sql))prepared.set(sql,db.prepare(sql));prepared.get(sql)!.run(...keys.map(k=>row[k]));
  };
  const stats={quotes:0,explicitTax:0,defaultTax:0,deferred:0,selfTax:0,alternatives:0,fixedFeesVerified:0,fixedFeesUnknown:0,structuredSurcharges:0,cargoWithExplicitEvidence:0};
  const task=(code:string,category:string,scope:unknown,fileId:string|null,sheet:string|null,title:string,detail:string,evidence:unknown,versions:string[])=>{
    const scopeKey=JSON.stringify([code,scope]),id=idFor('review',scopeKey);
    const existing=db.prepare('SELECT id,category FROM review_tasks WHERE id=?').get(id);
    if(!existing)put('review_tasks',{id,code,category,scope_key:scopeKey,source_file_id:fileId,sheet_name:sheet,title,detail,evidence_json:JSON.stringify(evidence),status:'open',created_at:now});
    else if(category==='business'&&existing.category!=='business')db.prepare('UPDATE review_tasks SET category=?,detail=?,evidence_json=? WHERE id=?').run(category,detail,JSON.stringify(evidence),id);
    for(const version of versions)db.prepare('INSERT OR IGNORE INTO review_task_quotes(task_id,quote_version_id) VALUES(?,?)').run(id,version);
    return id;
  };
  db.exec('BEGIN');
  try{
    // Re-running the same parser regenerates its inbox without accumulating tasks.
    db.exec("DELETE FROM review_task_quotes; UPDATE import_issues SET review_task_id=NULL; DELETE FROM review_tasks;");
    for(const batch of db.prepare(`SELECT b.*,f.sha256 FROM import_batches b JOIN source_files f ON f.id=b.source_file_id ORDER BY b.id`).all()){
      const source=sources.get(String(batch.sha256));
      if(!source)throw new Error(`Missing source evidence: ${batch.original_name}`);
      const contexts=new Map<string,SheetContext>();
      const rows=db.prepare(`SELECT v.*,r.source_quote_json,r.sheet_name,q.notes_json,i.channel_id,i.business_key,i.origin,i.country_code,i.destination_label,i.delivery_type,i.billing_basis,i.identity_status
        FROM quote_versions v JOIN import_rows r ON r.quote_version_id=v.id JOIN quote_rules q ON q.id=v.rule_id JOIN quote_items i ON i.id=v.quote_item_id WHERE v.batch_id=?`).all(batch.id);
      for(const row of rows){
        const id=String(row.id),fileId=String(batch.source_file_id),sheetName=String(row.sheet_name);
        if(!contexts.has(sheetName)){
          const sheet=source.sheets.find(s=>s.name===sheetName);if(!sheet)throw new Error(`Missing sheet ${sheetName}`);
          contexts.set(sheetName,new SheetContext(sheet));
        }
        const context=contexts.get(sheetName)!;
        const q={...JSON.parse(String(row.source_quote_json)),notes:JSON.parse(String(row.notes_json))} as Quote;
        const tierContexts=q.tiers.map(t=>context.context(q,t));
        const taxes=q.tiers.map((_,i)=>resolveTax(q,tierContexts[i].taxLevels));
        const tax=summarizeTax(taxes);
        const cargoEvidence=[...new Map(tierContexts.flatMap(c=>c.cargo).map(e=>[e.source+'|'+e.text,e])).values()];
        const cargo=resolveCargo(q,cargoEvidence);
        const scope=[...new Map(tierContexts.flatMap(c=>c.scope).map(e=>[e.source+'|'+e.text,e])).values()];
        const feeEvidence:unknown[]=[];
        const pending=new Map<string,string>();
        const perSheet=(code:string,category:string,title:string,detail:string,evidence:unknown)=>task(code,category,[batch.sha256,sheetName],fileId,sheetName,title,detail,evidence,[id]);
        // Keep original source JSON and its content hash intact; change only its interpretation.
        const business=JSON.parse(String(row.business_key));
        business.tax=tax.mode;business.settlement=tax.settlement;
        business.cargo=cargo.map(c=>[c.type,c.acceptance]).sort();
        const businessKey=JSON.stringify(business),itemId=idFor('item',businessKey);
        put('quote_items',{id:itemId,channel_id:String(row.channel_id),business_key:businessKey,origin:String(row.origin),country_code:String(row.country_code),
          destination_label:String(row.destination_label),delivery_type:String(row.delivery_type),billing_basis:String(row.billing_basis),currency:row.currency as string|null,
          tax_variant:tax.mode,cargo_variant:JSON.stringify(cargo.map(c=>[c.type,c.acceptance])),identity_status:String(row.identity_status)});
        if(tax.conflict){
          const taskId=perSheet('TAX_OPTIONS_REQUIRE_SELECTION','business','同一报价有多个税费选项','原表同一适用范围同时列出多种税费选项，需选择实际产品，不能套用默认包税。',{evidence:tax.evidence});
          pending.set('TAX_CONFLICT',taskId);pending.set('TAX_UNKNOWN',taskId);
        }
        for(const [ordinal,tier] of q.tiers.entries()){
          const tierId=idFor('tier',[id,ordinal]),t=taxes[ordinal];
          db.prepare(`UPDATE quote_tiers SET tax_mode=?,duty_inclusion=?,vat_inclusion=?,tax_settlement=?,tax_evidence_kind=?,tax_evidence=? WHERE id=?`)
            .run(t.mode,t.duty,t.vat,t.settlement,t.kind,t.evidence,tierId);
          if(tier.fixedFee!=null){
            const fee=context.fixedFee(tier);
            if(fee){
              db.prepare(`UPDATE quote_charge_rules SET label=?,charge_basis=?,review_status='verified',evidence_text=?,conditions_json=? WHERE id=?`)
                .run(fee.label,fee.basis,fee.evidence.map(e=>`${e.source}：${e.text}`).join('\n'),JSON.stringify({applies_to_tier:tierId,...(fee.zoneLabel?{delivery_zone:fee.zoneLabel}:{})}),idFor('charge',tierId));
              if(fee.zoneLabel)perSheet('POSTAL_ZONE_MAPPING','parsing','邮编分区与费用范围需补全','已明确处理费按票及适用分区；原数据只保留了其中一列费用，需完整关联其余分区及邮编，不能将该费用用于全国。',{zone:fee.zoneLabel,evidence:fee.evidence});
              feeEvidence.push({tierId,...fee});stats.fixedFeesVerified++;
            }else{
              stats.fixedFeesUnknown++;
              pending.set('FIXED_FEE_BASIS_UNKNOWN',perSheet('FIXED_FEE_BASIS_UNKNOWN','parsing','固定费用单位待定位','金额已保存，需检查本表的对应费用表头或合并单元格。',{sourceCell:tier.sourceCell,fixedFee:tier.fixedFee}));
            }
          }
        }
        db.prepare("DELETE FROM charge_rule_targets WHERE charge_rule_id IN (SELECT id FROM quote_charge_rules WHERE quote_version_id=? AND fee_code IN ('liftgate','residential'))").run(id);
        db.prepare("DELETE FROM quote_charge_rules WHERE quote_version_id=? AND fee_code IN ('liftgate','residential')").run(id);
        const fees=scopedFees(scope);
        for(const fee of fees){
          const chargeId=idFor('charge',[id,fee.code,fee.amount,fee.conditions]),amount=money(fee.amount);
          put('quote_charge_rules',{id:chargeId,quote_version_id:id,tier_id:null,fee_code:fee.code,label:fee.label,calculation_type:'fixed',charge_basis:fee.basis,
            amount_micros:amount.micros,amount_decimal:amount.decimal,currency:fee.currency,inclusion:'additional',stacking:'add',review_status:'verified',conditions_json:JSON.stringify(fee.conditions),evidence_text:fee.evidence});
          for(const prefix of fee.prefixes)put('charge_rule_targets',{id:idFor('charge_target',[chargeId,prefix]),charge_rule_id:chargeId,country_code:q.countryCode,target_kind:'postal_prefix',value:prefix,range_end:null,effect:'include'});
          stats.structuredSurcharges++;
        }
        db.prepare('DELETE FROM quote_cargo_types WHERE quote_version_id=?').run(id);
        for(const c of cargo)put('quote_cargo_types',{quote_version_id:id,cargo_type:c.type,acceptance:c.acceptance,evidence_kind:c.evidenceKind,
          conditions_json:JSON.stringify(c.conditions),evidence_text:c.evidence},'quote_version_id,cargo_type');
        if(cargo.some(c=>c.acceptance==='allowed'||c.acceptance==='conditional'))stats.cargoWithExplicitEvidence++;
        if(cargo.some(c=>c.acceptance==='unknown')){
          const unspecified=cargo.filter(c=>c.acceptance==='unknown').every(c=>c.type==='general'&&c.evidence==='原表未明确通用普货承运范围');
          pending.set('CARGO_UNCONFIRMED',perSheet('CARGO_SCOPE_UNCONFIRMED',unspecified?'reference':'business','货品适用范围资料补充',
            '未注明的货品能力保留未知，按工作表补资料；不阻止基础报价查看，敏感货筛选只使用有明确依据的能力。',{channel:q.channelName,evidence:cargoEvidence.slice(0,5)}));
        }
        if(!q.effectiveAt)pending.set('EFFECTIVE_DATE_UNCONFIRMED',task('EFFECTIVE_DATE_UNCONFIRMED','business',[batch.sha256],fileId,null,'报价生效日期需确认',
          '保留文件报价日期；没有明确生效依据时不将导入日期作为生效日期。',{file:batch.original_name,quotedOn:q.priceDate},[id]));
        const remainingNotes=q.notes.filter(n=>/附加费|加收|另收|另计|派送费|清关费|处理费|挂号费|尾板费|住宅地址费|等时费/.test(n));
        if(remainingNotes.length)pending.set('UNSTRUCTURED_CHARGES',perSheet('REMAINING_CHARGE_RULES','parsing','本表剩余附加费规则待结构化',
          '已提取明确固定费及适用范围明确的费用；复杂收费、优惠、最低收费与叠加关系仍保留原文，按工作表处理。',{examples:remainingNotes.slice(0,3).map(s=>s.slice(0,1200))}));
        const semantic={version:SEMANTIC_VERSION,policy:TAX_POLICY,tierTax:taxes,cargoEvidence,verifiedFixedFees:feeEvidence,structuredSurcharges:fees};
        db.prepare(`UPDATE quote_versions SET quote_item_id=?,tax_mode=?,duty_inclusion=?,vat_inclusion=?,tax_settlement=?,tax_evidence=?,semantic_parser_version=?,tax_evidence_kind=?,semantic_evidence_json=? WHERE id=?`)
          .run(itemId,tax.mode,tax.duty,tax.vat,tax.settlement,tax.evidence,SEMANTIC_VERSION,tax.kind,JSON.stringify(semantic),id);
        // Maintain a shared directory task without inferring a platform from
        // page-wide references to Amazon or Walmart. Codes can overlap.
        if(q.warehouseCodes.length){
          pending.set('WAREHOUSE_PLATFORM_UNVERIFIED',task('WAREHOUSE_DIRECTORY_INCOMPLETE','reference',[q.countryCode],null,null,`${q.countryCode} 仓库资料维护`,
            '仓码复用同一份资料，平台及详细地址按仓库字典维护，不逐报价重复询问。',{country:q.countryCode},[id]));
        }
        if(q.source.hidden)perSheet('HIDDEN_SHEET_AVAILABILITY','business','隐藏工作表的渠道可用性','原表工作页隐藏，保留历史报价，出货前需确认该渠道是否仍有效。',{file:batch.original_name,sheet:sheetName});
        for(const old of db.prepare("SELECT id,code FROM import_issues WHERE quote_version_id=? AND severity='review'").all(id)){
          const taskId=pending.get(String(old.code));
          db.prepare('UPDATE import_issues SET resolution=?,resolved_at=?,review_task_id=? WHERE id=?').run(taskId?'已归并至共享复核任务':'已按原表对应位置及用户确认的业务口径重新解析',now,taskId??null,old.id);
        }
        stats.quotes++;if(tax.kind==='business_default')stats.defaultTax++;else stats.explicitTax++;
        if(tax.settlement.includes('deferred'))stats.deferred++;
        if(tax.settlement.includes('customer_tax'))stats.selfTax++;
        if(tax.settlement==='alternatives'||tax.settlement==='tier_specific')stats.alternatives++;
      }
      for(const old of db.prepare("SELECT * FROM import_issues WHERE batch_id=? AND quote_version_id IS NULL AND severity='review'").all(batch.id)){
        const isCoverage=old.code==='SAMPLED_REFERENCE_SHEETS';
        const id=task(String(old.code),'parsing',[batch.sha256],String(batch.source_file_id),null,isCoverage?'大型附表提取覆盖待补充':'同条件报价关联需复核',String(old.message),JSON.parse(String(old.evidence_json)),[]);
        db.prepare('UPDATE import_issues SET resolution=?,resolved_at=?,review_task_id=? WHERE id=?').run('已归并至共享复核任务',now,id,old.id);
      }
      console.log(`Refined ${batch.original_name}: ${rows.length} quotes (${stats.quotes} total)`);
    }
    db.exec('DELETE FROM quote_items WHERE NOT EXISTS(SELECT 1 FROM quote_versions v WHERE v.quote_item_id=quote_items.id)');
    put('audit_logs',{id:idFor('audit',SEMANTIC_VERSION),actor:'owner-authorized-refinement',action:'refine_quote_semantics',entity_type:'database',entity_id:'freight-quotes',occurred_at:now,detail_json:JSON.stringify({policy:TAX_POLICY,stats})});
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Foreign key errors');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
  const report={generatedAt:now,version:SEMANTIC_VERSION,policy:TAX_POLICY,stats,
    taxModes:db.prepare('SELECT tax_mode,tax_settlement,tax_evidence_kind,count(*) AS quotes FROM quote_versions GROUP BY tax_mode,tax_settlement,tax_evidence_kind').all(),
    tasks:db.prepare('SELECT category,code,count(*) AS tasks FROM review_tasks WHERE status=\'open\' GROUP BY category,code').all(),
    legacyIssues:db.prepare('SELECT count(*) AS total,sum(resolved_at IS NULL) AS unresolved FROM import_issues WHERE severity=\'review\'').get(),
    warehouses:db.prepare('SELECT platform,count(*) AS warehouses FROM warehouses GROUP BY platform').all()};
  fs.writeFileSync(path.join(output,'refinement-report.json'),JSON.stringify(report,null,2));
  db.close();console.log(JSON.stringify(report));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const output=process.argv[3]??'.local/d1-refinement';refineHistory(process.argv[2]??path.join(output,'freight-quotes.sqlite'),output);
}
