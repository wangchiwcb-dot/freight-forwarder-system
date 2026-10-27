import Decimal from 'decimal.js';
import type { DraftQuote, PriceDraftRecord } from './review-contracts';
import type { Billing, PricingRequest, QuoteResult } from './pricing-contracts';
import type { ComparisonItem, ComparisonOptions, ComparisonSummary } from './comparison-contracts';
import { quantity } from './pricing';

const D=Decimal.clone({precision:60});
const money=(value:Decimal)=>value.toFixed(2);
const asDecimal=(value:number|null|undefined,fallback:string|null=null)=>value==null?fallback:new D(value).toString();
const normalize=(value:string)=>value.trim().toUpperCase().replace(/\s/g,'');
const cargoNames:Record<string,string>={built_in_battery:'battery',battery:'battery',pure_battery:'pure_battery',magnetic:'magnetic',liquid:'liquid',powder:'powder'};

function coverage(quote:DraftQuote,input:PricingRequest):ComparisonItem['coverage'] {
  const checks:(boolean|null)[]=[];
  const postal=normalize(input.postalCode).replace(/^(\d{5})-\d{4}$/,'$1');
  const warehouse=normalize(input.warehouseCode);
  if (quote.warehouseCodes?.length) checks.push(warehouse ? quote.warehouseCodes.some(code=>normalize(code)===warehouse):null);
  if (quote.postalCodes?.length) checks.push(postal ? quote.postalCodes.some(code=>normalize(code)===postal):null);
  if (quote.postalPrefixes?.length) checks.push(postal ? quote.postalPrefixes.some(code=>postal.startsWith(normalize(code))):null);
  if (quote.postalRanges?.length) checks.push(postal ? quote.postalRanges.some(({start,end})=>/^\d+$/.test(postal)&&postal.length===start.length&&postal>=start&&postal<=end):null);
  if (!checks.length) return 'unknown';
  if (checks.includes(true)) return 'matched';
  return checks.includes(null)?'unknown':'rejected';
}

export function estimateSource(draft:PriceDraftRecord,input:PricingRequest,options:ComparisonOptions,cache=new Map<string,ReturnType<typeof quantity>>()):ComparisonItem {
  const quote=draft.proposed_data;
  const warnings=[...(quote.reviewReasons??[])];
  const assumptions:string[]=[];
  let eligibility=coverage(quote,input);
  let blocked=eligibility==='rejected';
  if (blocked) warnings.unshift('邮编或仓码不在本条报价覆盖范围');
  if (eligibility==='unknown') warnings.unshift('目的地覆盖待核，填写准确邮编或仓码可缩小范围');
  if (draft.status==='excluded' || quote.source.hidden || quote.status==='suspended') { blocked=true;warnings.unshift('排除、隐藏或暂停渠道，暂不参与比价'); }
  const start=[draft.version_from,quote.effectiveAt?.slice(0,10)].filter((v):v is string=>Boolean(v)).sort().at(-1);
  const end=[draft.version_to,quote.validTo?.slice(0,10)].filter((v):v is string=>Boolean(v)).sort()[0];
  if (draft.pricing_state==='pending') { blocked=true;warnings.unshift('新报价表尚未确认生效'); }
  if (start && input.asOf<start || end && input.asOf>=end) { blocked=true;warnings.unshift('报价不在适用日期内'); }
  if (!start) warnings.push('生效日期待核');
  if (quote.delivery && quote.delivery!=='all' && quote.delivery!=='unknown' && input.addressType!=='unknown') {
    const wanted=input.addressType==='platform'?'amazon':input.addressType;
    if (quote.delivery!==wanted) { blocked=true;warnings.unshift('派送地址类型不适用'); }
  }
  if (quote.origin && input.origin && !/按原表|待核|待确认|未知/.test(quote.origin) && !quote.origin.includes(input.origin)) {
    blocked=true;warnings.unshift('交仓点不同，尚未计入转运费用');
  }
  const attributes=input.cargoAttributes?.length?input.cargoAttributes:['general'];
  for (const attribute of attributes) {
    const type=cargoNames[attribute]??attribute;
    const rule=quote.cargoAcceptance?.find(rule=>rule.type===type);
    if (rule?.acceptance==='forbidden') { blocked=true;warnings.unshift(`原表不接该货品属性：${attribute}`); }
    else if (rule?.acceptance!=='allowed' && !(quote.cargoCertainty==='explicit' && quote.cargoTypes?.includes(type as any))) warnings.push(`承运属性待核：${attribute==='general'?'普货':attribute}`);
  }
  if (input.intellectualProperty!=='clear') warnings.push('侵权仿牌情况需要确认');
  if (!input.origin) warnings.push('未指定交仓点，各报价的起运成本可能不同');
  if (input.addressType==='unknown') warnings.push('地址类型未确认，地址附加费待核');
  warnings.push('附加费、进位、服务及税费范围未完整复核，参考费用不代表最终结算价');
  const row:ComparisonItem={id:`source_${draft.id}`,draftId:draft.id,offerId:null,provider:draft.provider_hint,channel:draft.channel_hint,
    versionLabel:draft.version_label??null,validFrom:start??null,validTo:end??null,
    mode:draft.mode_hint,country:draft.country_hint,destination:quote.destinationLabel??'',origin:quote.origin||null,
    currency:quote.currency??null,basis:quote.billingBasis,quantity:null,unitPrice:null,tierLabel:null,baseFreight:null,knownSurcharges:null,knownCost:null,completeCost:null,
    status:'needs_parameters',coverage:eligibility,lowestReference:false,lowestComplete:false,comparisonKey:null,warnings,assumptions,lines:[],
    tiers:(quote.tiers??[]).map(tier=>({label:tier.label,price:asDecimal(tier.price),status:tier.status})),transitText:quote.transitText??'',
    source:{id:draft.source_id,name:draft.source_name,sheet:quote.source.sheet,cells:quote.source.cells}};
  if (blocked) { row.status='unavailable';row.coverage='rejected';return row; }
  if (/^(请注意|注意[：:]|备注[：:]|温馨提示|特殊说明|收费说明)/.test(draft.channel_hint.trim())) {
    warnings.unshift('原表说明文字被识别为渠道名，需先核实渠道归属');return row;
  }
  if (/自提|仓储/.test(`${quote.channelName} ${quote.destinationLabel}`)) {
    warnings.unshift('此报价涉及自提或仓储，需另核门到门派送范围和计价单位');return row;
  }
  if (quote.billingBasis==='cbm'&&!quote.densityConversionKgPerCbm&&/1\s*(?:CBM|方)\s*[=＝]\s*\d+\s*KG/i.test(quote.channelName)) {
    warnings.unshift('原表标有重货密度换算，需核实每方计价单位及换算规则');return row;
  }
  if (!['kg','cbm'].includes(quote.billingBasis)) { warnings.unshift('首续重或其他计费方式需补齐规则');return row; }
  const fallback=quote.billingBasis==='kg'&&!quote.volumetricDivisor?options.fallbackDivisor:null;
  if (fallback) assumptions.push(`本次手填参考材积系数 ${fallback}，不代表渠道已确认规则`);
  const billing:Billing={basis:quote.billingBasis as 'kg'|'cbm',aggregation:quote.billingBasis==='cbm'?'shipment':options.referenceAggregation,
    volumetricDivisor:asDecimal(quote.volumetricDivisor,fallback),quantityStep:options.referenceStep,dimensionStepCm:'0',volumeStepCbm:'0',
    minimumQuantity:asDecimal(quote.billingBasis==='cbm'?quote.minCbm:quote.minShipmentKg,'0')!,minimumPieceKg:asDecimal(quote.minPieceKg,'0')!,
    densityKgPerCbm:asDecimal(quote.densityConversionKgPerCbm),verified:true};
  assumptions.push(`${billing.aggregation==='shipment'?'整票':'逐箱'}取大参考测算，计费量${options.referenceStep==='0'?'不另行进位':`向上进位到 ${options.referenceStep}`}；实际进位需核对原表`);
  if (quote.minPieceKg==null || quote.minShipmentKg==null) warnings.push('未提取到的最低计费限制仍待核');
  const key=JSON.stringify(billing);
  let counted=cache.get(key);
  if (!counted) { counted=quantity(input,billing);cache.set(key,counted); }
  if (counted.value===null) { warnings.unshift(...counted.reasons);return row; }
  row.quantity=counted.value.toString();
  if (quote.maxKgPerCbm!=null) {
    const actual=input.packages.length?input.packages.every(p=>p.actualKg!==null)?input.packages.reduce((sum,p)=>sum.add(new D(p.actualKg!).mul(p.pieces)),new D(0)):null:input.actualKg?new D(input.actualKg):null;
    const cbm=input.packages.length?input.packages.every(p=>p.lengthCm&&p.widthCm&&p.heightCm)?input.packages.reduce((sum,p)=>sum.add(new D(p.lengthCm!).mul(p.widthCm!).mul(p.heightCm!).mul(p.pieces).div(1e6)),new D(0)):null:input.volumeCbm?new D(input.volumeCbm):null;
    if (!actual||!cbm) { warnings.unshift('密度限制需要完整实重和体积');return row; }
    if (actual.div(cbm).gt(quote.maxKgPerCbm)) { row.status='unavailable';row.coverage='rejected';warnings.unshift('货物密度超过此渠道上限');return row; }
  }
  const tiers=quote.tiers.filter(tier=>(tier.min!==null||tier.max!==null)&&
    (tier.min==null||(tier.minInclusive===false?counted!.value!.gt(tier.min):counted!.value!.gte(tier.min)))&&
    (tier.max==null||(tier.maxInclusive===true?counted!.value!.lte(tier.max):counted!.value!.lt(tier.max))));
  if (tiers.length!==1) { warnings.unshift(tiers.length?'价格档位重叠，需选择适用档位':'计费量没有命中原表价格档位');row.status='inquiry';return row; }
  const tier=tiers[0];row.tierLabel=tier.label;
  if (tier.status==='unavailable') { row.status='unavailable';warnings.unshift('本档位不承运');return row; }
  if (tier.price==null || tier.status!=='priced') { row.status='inquiry';warnings.unshift('本档位需要询价');return row; }
  row.unitPrice=asDecimal(tier.price);row.baseFreight=money(counted.value.mul(tier.price));
  let extra=new D(0);
  row.lines.push({ruleId:'base',label:'参考基础运费',packageId:null,quantity:row.quantity,unitPrice:row.unitPrice,amount:row.baseFreight,inclusion:'additional',evidence:`原表 ${quote.source.sheet} ${tier.sourceCell}`});
  if (tier.fixedFee!=null) {
    const pieces=input.packages.length?input.packages.reduce((sum,p)=>sum+p.pieces,0):input.pieces;
    if (!tier.fixedFeeConfirmed || !['piece','shipment'].includes(tier.fixedFeeBasis??'') || tier.fixedFeeBasis==='piece'&&pieces===null) warnings.push('档位固定处理费的计费单位或金额待核，尚未计入');
    else {
      const units=tier.fixedFeeBasis==='piece'?pieces!:1;
      extra=extra.add(new D(tier.fixedFee).mul(units));
      row.lines.push({ruleId:'fixed',label:'已识别固定处理费',packageId:null,quantity:String(units),unitPrice:String(tier.fixedFee),amount:money(extra),inclusion:'additional',evidence:`原表 ${tier.sourceCell}`});
    }
  }
  row.knownSurcharges=extra.gt(0)?money(extra):null;
  row.knownCost=money(new D(row.baseFreight).add(extra));row.status='reference';
  row.warnings=[...new Set(warnings)];return row;
}

export function fromRuleResult(result:QuoteResult,draft:PriceDraftRecord|null):ComparisonItem {
  const offer=result.offer,base=result.lines.find(line=>line.ruleId==='base');
  const extra=result.lines.filter(line=>line.ruleId!=='base'&&line.amount!==null).reduce((sum,line)=>sum.add(line.amount!),new D(0));
  const destination=offer.targets.map(target=>target.value).join('、')||offer.country;
  return {id:`offer_${offer.id}`,draftId:draft?.id??null,offerId:offer.id,provider:offer.providerName,channel:offer.name,mode:offer.mode,country:offer.country,destination,
    versionLabel:offer.versionLabel??null,validFrom:offer.validFrom,validTo:offer.validTo,
    origin:offer.origin,currency:offer.currency,basis:offer.billing.basis,quantity:result.chargeableQuantity,
    unitPrice:base?.unitPrice??null,tierLabel:null,baseFreight:base?.amount??null,knownSurcharges:result.lines.some(line=>line.ruleId!=='base'&&line.amount!==null)?money(extra):null,
    knownCost:base?.amount!==undefined&&base.amount!==null?result.knownSubtotal:null,completeCost:result.total,status:result.state==='rejected'?'unavailable':result.state==='complete'?'complete':base?.amount?'reference':'needs_parameters',
    coverage:result.state==='rejected'?'rejected':result.reasons.some(reason=>reason.includes('完整目的邮编')||reason.includes('交仓点不同'))?'unknown':'matched',
    lowestReference:false,lowestComplete:result.lowest,comparisonKey:result.comparisonKey,warnings:result.reasons,
    assumptions:[],lines:result.lines,tiers:offer.tiers.map(tier=>({label:`${tier.min}–${tier.max??'以上'}`,price:tier.unitPrice,status:tier.status})),transitText:offer.transitText,
    source:draft?{id:draft.source_id,name:draft.source_name,sheet:draft.proposed_data.source.sheet,cells:draft.proposed_data.source.cells}:offer.sourceEvidence[0]?{id:offer.sourceEvidence[0].sourceId,name:'渠道规则依据',sheet:offer.sourceEvidence[0].sheet,cells:offer.sourceEvidence[0].cells}:null};
}

export function rankComparison(items:ComparisonItem[]):ComparisonItem[] {
  const bucket=(row:ComparisonItem)=>row.status==='unavailable'?4:row.knownCost!==null?row.coverage==='matched'?0:1:2;
  items.sort((a,b)=>bucket(a)-bucket(b)||(a.currency??'ZZZ').localeCompare(b.currency??'ZZZ')||
    (a.knownCost!==null&&b.knownCost!==null?new D(a.knownCost).comparedTo(b.knownCost):0)||a.id.localeCompare(b.id));
  const referenceMin=new Map<string,string>();const completeMin=new Map<string,string>();
  for(const row of items) if(row.status!=='unavailable'&&row.currency&&row.coverage==='matched') {
    if(row.knownCost!==null) {
      const min=referenceMin.get(row.currency);if(min===undefined||new D(row.knownCost).lt(min)) referenceMin.set(row.currency,row.knownCost);
    }
    if(row.completeCost!==null&&row.comparisonKey) {
      const min=completeMin.get(row.comparisonKey);if(min===undefined||new D(row.completeCost).lt(min)) completeMin.set(row.comparisonKey,row.completeCost);
    }
  }
  for(const row of items) {
    row.lowestReference=row.status!=='unavailable'&&row.coverage==='matched'&&row.knownCost!==null&&row.currency!==null&&referenceMin.get(row.currency)===row.knownCost;
    row.lowestComplete=row.completeCost!==null&&row.comparisonKey!==null&&completeMin.get(row.comparisonKey)===row.completeCost;
  }
  return items;
}
export function comparisonSummary(items:ComparisonItem[],selected:number):ComparisonSummary {
  return {candidates:items.length,calculated:items.filter(row=>row.knownCost!==null&&row.status!=='unavailable').length,
    needsParameters:items.filter(row=>row.status==='needs_parameters'||row.status==='inquiry').length,unavailable:items.filter(row=>row.status==='unavailable').length,
    providers:new Set(items.map(row=>row.provider)).size,sources:new Set(items.map(row=>row.source?.id).filter(Boolean)).size,selected,
    currencies:[...new Set(items.map(row=>row.currency).filter((value):value is string=>Boolean(value)))].sort()};
}
