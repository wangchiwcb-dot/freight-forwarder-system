import {describe,it,expect} from 'vitest';
import type {Quote} from '../../src/domain/types';
import {SheetContext,resolveTax,resolveCargo,scopedFees,summarizeTax} from './semantics';
import type {Sheet,Evidence} from './semantics';

const quote=(patch:Partial<Quote>={})=>({channelName:'海运专线',countryCode:'US',billingBasis:'kg',cargoTypes:['general'],cargoCertainty:'inferred',
  source:{sheet:'普通报价',cells:['D14']},tiers:[{label:'100KG+',sourceCell:'D14',price:12,min:100,max:null,status:'priced',fixedFee:34}],...patch} as Quote);
const evidence=(text:string):Evidence=>({source:'测试表!A1',text});
describe('source-scoped semantic refinement',()=>{
  it('records the user default separately from explicit tax evidence',()=>{
    const tax=resolveTax(quote(),[[evidence('海运专线')]]);
    expect(tax).toMatchObject({mode:'included',kind:'business_default',vat:'unknown'});
    expect(resolveTax(quote(),[[evidence('海运不包税')]])).toMatchObject({mode:'excluded',kind:'explicit'});
  });
  it('uses a specific tax column instead of a mixed heading',()=>{
    expect(resolveTax(quote(),[[evidence('2CBM+(不包税)')],[evidence('包税1:167 不包税1:363')]])).toMatchObject({mode:'excluded',conflict:false});
    expect(resolveTax(quote(),[[],[],[evidence('包税/递延')],[evidence('包税')]])).toMatchObject({mode:'conditional',settlement:'alternatives'});
  });
  it('keeps UK/EU VAT deferred, self-paid and included prices distinct',()=>{
    const q=quote({countryCode:'GB'});
    expect(resolveTax(q,[[evidence('UK快递-PVA')]])).toMatchObject({mode:'conditional',settlement:'deferred',vat:'excluded'});
    expect(resolveTax(q,[[evidence('UK快递-VAT')]])).toMatchObject({mode:'conditional',settlement:'customer_tax',vat:'excluded'});
    expect(resolveTax(q,[[evidence('含税')]])).toMatchObject({mode:'included',settlement:'unknown'});
    expect(resolveTax(q,[[evidence('VAT自税\nVAT递延')]])).toMatchObject({settlement:'deferred_or_customer_tax',mode:'conditional'});
    expect(resolveTax(q,[[evidence('含关税 不含VAT')]])).toMatchObject({mode:'partial',vat:'excluded',duty:'included'});
  });
  it('does not use CBM-only labels for KG prices',()=>{
    expect(resolveTax(quote(),[[evidence('渠道按方包税')]])).toMatchObject({kind:'business_default'});
  });
  it('resolves adjacent remarks and fee headers inside the correct vertical section',()=>{
    const sheet:Sheet={name:'超敏感',merged_ranges:['G14:G15'],head:[
      {row:4,cells:[{coord:'D4',value:'RMB/KG'},{coord:'E4',value:'处理费/件'},{coord:'G4',value:'备注'}]},
      {row:5,cells:[{coord:'D5',value:11},{coord:'E5',value:22},{coord:'G5',value:'不包税'}]},
      {row:13,cells:[{coord:'D13',value:'RMB/KG'},{coord:'E13',value:'处理费/票'},{coord:'G13',value:'备注'}]},
      {row:14,cells:[{coord:'D14',value:12},{coord:'E14',value:34},{coord:'G14',value:'可发:保健品\n包税'}]},
      {row:15,cells:[{coord:'D15',value:13},{coord:'E15',value:34}]},
    ]};
    const context=new SheetContext(sheet),q=quote(),tier=q.tiers[0];
    expect(context.fixedFee(tier)).toMatchObject({basis:'shipment',amount:34});
    expect(resolveTax(q,context.context(q,tier).taxLevels)).toMatchObject({mode:'included',kind:'explicit'});
    const cargo=resolveCargo(q,context.context(q,tier).cargo);
    expect(cargo).toContainEqual(expect.objectContaining({type:'health_supplement',acceptance:'allowed'}));
    expect(cargo.some(c=>c.type==='general'&&c.acceptance==='unknown')).toBe(false);
    expect(context.fixedFee({...tier,fixedFee:35})).toBeNull();
  });
  it('does not interpret sensitive cargo as pure-battery acceptance',()=>{
    const rules=resolveCargo(quote(),[{source:'渠道名称',text:'敏感货专线'},{source:'表!G5',text:'不接纯电;可接带电,需要提供鉴定'}]);
    expect(rules.find(c=>c.type==='pure_battery')?.acceptance).toBe('forbidden');
    expect(rules.find(c=>c.type==='battery')?.acceptance).toBe('conditional');
    expect(rules.some(c=>c.type==='general')).toBe(false);
    const mixed=resolveCargo(quote(),[{source:'表!G5',text:'可接带电，不接纯电'}]);
    expect(mixed.find(c=>c.type==='battery')?.acceptance).toBe('allowed');
    expect(mixed.find(c=>c.type==='pure_battery')?.acceptance).toBe('forbidden');
    const onlyGeneral=resolveCargo(quote(),[{source:'工作表名称',text:'敏感专线'},{source:'表!G5',text:'只出普货'}]);
    expect(onlyGeneral.find(c=>c.type==='general')?.acceptance).toBe('allowed');
    expect(onlyGeneral.find(c=>c.type==='sensitive')?.acceptance).toBe('forbidden');
    expect(resolveCargo(quote(),[{source:'表!G5',text:'带电请单询'}]).find(c=>c.type==='battery')?.acceptance).toBe('conditional');
    const power=resolveCargo(quote(),[{source:'表!F5',text:'可接低于100w内置电产品;带电带磁免加收'}]);
    expect(power.find(c=>c.type==='battery')?.acceptance).toBe('conditional');
    expect(power.find(c=>c.type==='magnetic')?.acceptance).toBe('allowed');
  });
  it('reads vertically merged headers while retaining regional fee scope',()=>{
    const sheet:Sheet={name:'澳洲报价',merged_ranges:['C4:C5','D4:F4'],head:[
      {row:4,cells:[{coord:'C4',value:'RMB/KG'},{coord:'D4',value:'处理费/票'}]},
      {row:5,cells:[{coord:'D5',value:'分区1'},{coord:'E5',value:'分区2'}]},
      {row:6,cells:[{coord:'C6',value:70},{coord:'D6',value:27.2},{coord:'E6',value:38.7}]}
    ]};
    const context=new SheetContext(sheet);
    expect(context.fixedFee({label:'100KG+',sourceCell:'C6',price:70,min:100,max:null,status:'priced',fixedFee:27.2})).toMatchObject({basis:'shipment',zoneLabel:'分区1'});
  });
  it('keeps residential/postcode and unloading conditions with USD fees',()=>{
    const fees=scopedFees([evidence('收件人无卸货能力\n需额外支付60美金/票尾板费\n75、76开头邮编住宅地址需额外加收100美金/票住宅地址费')]);
    expect(fees).toHaveLength(2);
    expect(fees[0]).toMatchObject({amount:60,currency:'USD',basis:'shipment',conditions:{recipient_can_unload:false}});
    expect(fees[1]).toMatchObject({amount:100,conditions:{address_type:'residential',postal_prefixes:['75','76']}});
  });
  it('does not mark a quote with differently taxed tiers wholly included',()=>{
    expect(summarizeTax([resolveTax(quote(),[[evidence('包税')]]),resolveTax(quote(),[[evidence('不包税')]])]).mode).toBe('conditional');
  });
});
