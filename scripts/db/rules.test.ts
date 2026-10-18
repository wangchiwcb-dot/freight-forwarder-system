import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { taxTerms,cargoRules,money,itemIdentity,sqlLiteral } from './rules';
import type { Quote } from '../../src/domain/types';

const sample=(patch:Partial<Quote>={})=>({providerId:'a',channelName:'美森普货',mode:'sea',countryCode:'US',origin:'深圳',destinationLabel:'ONT8',delivery:'amazon',
  billingBasis:'kg',currency:'CNY',cargoTypes:['general'],cargoCertainty:'explicit',...patch} as Quote);
describe('historical import business semantics',()=>{
  it('distinguishes included, excluded, unknown and deferred tax',()=>{
    expect(taxTerms('欧洲海运不包税').mode).toBe('excluded');
    expect(taxTerms('欧洲海运包税').mode).toBe('included');
    expect(taxTerms('欧洲VAT递延').mode).toBe('unknown');
    expect(taxTerms('欧洲VAT递延').settlement).toBe('deferred');
    expect(taxTerms('含关税 不含VAT').mode).toBe('partial');
    expect(taxTerms('包税/不包税').mode).toBe('unknown');
    expect(taxTerms('DDP').mode).toBe('unknown');
  });
  it('does not promote sensitive/general defaults to proven battery acceptance',()=>{
    const rows=cargoRules(sample({channelName:'敏感货',cargoTypes:['general','sensitive']}));
    expect(rows.find(r=>r.type==='general')?.acceptance).toBe('unknown');
    expect(rows.find(r=>r.type==='sensitive')?.acceptance).toBe('allowed');
    expect(rows.some(r=>r.type==='pure_battery')).toBe(false);
    expect(cargoRules(sample({channelName:'普货不接带电',cargoTypes:['general','battery']})).find(r=>r.type==='battery')?.acceptance).toBe('forbidden');
  });
  it('keeps business identity independent of file and coordinates while separating tax/cargo variants',()=>{
    expect(itemIdentity(sample({id:'old'}),'included')).toEqual(itemIdentity(sample({id:'new'}),'included'));
    expect(itemIdentity(sample(),'included')).not.toEqual(itemIdentity(sample(),'excluded'));
    expect(itemIdentity(sample(),'included')).not.toEqual(itemIdentity(sample({cargoTypes:['battery']}),'included'));
  });
  it('preserves money precision, unknown prices and postal strings',()=>{
    expect(money(1190.376)).toEqual({micros:1190376000,decimal:'1190.376'});
    expect(money(null)).toEqual({micros:null,decimal:null});
    expect(()=>money(-1)).toThrow();
    expect(sqlLiteral('00123')).toBe("'00123'");
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });
  it('blocks partial batch publication and invalid price rows in SQLite/D1 schema',()=>{
    const db=new DatabaseSync(':memory:');
    db.exec(fs.readFileSync('migrations/0001_quote_history.sql','utf8'));
    db.exec("INSERT INTO providers(id,name,is_own) VALUES('p','p',0); INSERT INTO source_files(id,sha256,original_name) VALUES('f','hash','f.xlsx');");
    db.exec("INSERT INTO import_batches(id,source_file_id,provider_id,parser_version,idempotency_key,original_name,expected_quotes,imported_at,coverage_json) VALUES('b','f','p','v1','key','f',1,'2026-10-17','{}')");
    expect(()=>db.exec("UPDATE import_batches SET status='published' WHERE id='b'")).toThrow('incomplete quote batch');
    expect(()=>db.exec("INSERT INTO quote_items(id,channel_id,business_key,origin,country_code,destination_label,delivery_type,billing_basis,tax_variant,cargo_variant) VALUES('i','missing','k','SZ','US','ONT8','amazon','kg','unknown','[]')")).toThrow();
    db.close();
  });
});
