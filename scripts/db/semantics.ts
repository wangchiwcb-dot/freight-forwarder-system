import type { Quote, RateTier } from '../../src/domain/types.ts';

export const SEMANTIC_VERSION = 'quote-semantics/2';
export const TAX_POLICY = 'owner-confirmed/2026-10-17:未注明不包税默认包税；VAT递延/自税独立识别';
export type Cell = {coord:string; value?:unknown; formula?:unknown; cached?:unknown};
export type Sheet = {name:string; head:{row:number;cells:Cell[]}[]; tail?:{row:number;cells:Cell[]}[]; merged_ranges?:string[]};
export type Evidence = {source:string; text:string};
export const cellValue=(c?:Cell)=>c?.formula?c.cached:c?.value;
const text=(c?:Cell)=>String(cellValue(c)??'').normalize('NFKC').replace(/\r/g,'').trim();
export const column=(coord:string)=>[...(coord.match(/^[A-Z]+/)?.[0]??'')].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const rowNumber=(coord:string)=>Number(coord.match(/\d+/)?.[0]);
const letters=(n:number)=>{let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
const unique=(rows:Evidence[])=>[...new Map(rows.filter(r=>r.text&&!r.text.startsWith('=')).map(r=>[r.source+'|'+r.text,r])).values()];
const priceHeader=(s:string)=>s.length<100&&/RMB\s*\/\s*KG|运费.*(?:KG|公斤)|\d.*(?:KG|CBM|公斤|方)|单价.*CBM|按方算/i.test(s)&&!/赔|加收|最低消费|等时费/.test(s);

/** Read only evidence belonging to this price column/row/merged block. */
export class SheetContext {
  cells:Map<string,Cell>;
  rows:Map<number,Cell[]>;
  merges:{r1:number;r2:number;c1:number;c2:number;anchor:string}[];
  sheet:Sheet;
  resolvedCells=new Map<string,Cell|undefined>();
  headerRows=new Map<number,number[]>();
  constructor(sheet:Sheet){
    this.sheet=sheet;
    const rows=[...sheet.head,...(sheet.tail??[])];
    this.cells=new Map(rows.flatMap(r=>r.cells.map(c=>[c.coord,c])));
    this.rows=new Map(rows.map(r=>[r.row,r.cells]));
    this.merges=(sheet.merged_ranges??[]).flatMap(range=>{
      const [a,b]=range.split(':');return b?[{r1:rowNumber(a),r2:rowNumber(b),c1:column(a),c2:column(b),anchor:a}]:[];
    });
  }
  get(r:number,c:number):Cell|undefined{
    const key=letters(c)+r,cell=this.cells.get(key);if(cell)return cell;
    if(this.resolvedCells.has(key))return this.resolvedCells.get(key);
    const merge=this.merges.find(m=>r>=m.r1&&r<=m.r2&&c>=m.c1&&c<=m.c2);
    const resolved=merge?this.cells.get(merge.anchor):undefined;
    this.resolvedCells.set(key,resolved);return resolved;
  }
  evidence(c?:Cell):Evidence|undefined{return c&&text(c)?{source:`${this.sheet.name}!${c.coord}`,text:text(c)}:undefined;}
  header(tier:RateTier){
    const r=rowNumber(tier.sourceCell),c=column(tier.sourceCell);
    if(!this.headerRows.has(c))this.headerRows.set(c,[...this.rows.keys()].sort((a,b)=>a-b).filter(rr=>{
      const cell=this.get(rr,c);return typeof cellValue(cell)!=='number'&&priceHeader(text(cell));
    }));
    const headerRow=this.headerRows.get(c)!.filter(rr=>rr<r).at(-1)??0;
    return {row:headerRow?rowNumber(this.get(headerRow,c)!.coord):0,column:c};
  }
  context(q:Quote,tier:RateTier){
    const r=rowNumber(tier.sourceCell),h=this.header(tier);
    const cols:Evidence[]=[],row:Evidence[]=[],headings:Evidence[]=[];
    // A full-width title is a block heading, never a column-specific override.
    for(let rr=h.row;rr>=Math.max(1,h.row-4);rr--){
      const cell=this.get(rr,h.column),e=this.evidence(cell);
      const merge=this.merges.find(m=>m.anchor===cell?.coord);
      if(e&&e.text.length<180&&(!merge||merge.c2-merge.c1<3))cols.push(e);
    }
    // Resolve vertically merged channel cells and remarks using their headers.
    const labels=(this.rows.get(h.row)??[]).filter(c=>/渠道|下单代码|备注|说明|货物类型|货品/.test(text(c)));
    for(const label of labels){const e=this.evidence(this.get(r,column(label.coord)));if(e)row.push(e);}
    // Left-side channel names can be on data rows even if the header is generic.
    for(let c=1;c<h.column;c++){
      const cell=this.get(r,c),e=this.evidence(cell);
      if(e&&/海|空派|专线|卡航|铁路|快铁|普铁|快递|递延|包税|含税|自税|VAT|PVA|普货|敏感|带电|带磁/i.test(e.text))row.push(e);
    }
    // Title immediately before the current header, constrained to its block.
    for(let rr=h.row-1;rr>=Math.max(1,h.row-3);rr--){
      const candidates=(this.rows.get(rr)??[]).filter(c=>column(c.coord)<=h.column&&typeof cellValue(c)==='string');
      for(const c of candidates){
        const e=this.evidence(c);
        if(e&&e.text.length<220&&!/有限公司|公司地址|价格目录/.test(e.text)&&/海|空派|专线|卡航|铁路|VAT|PVA|包税|递延|普货|敏感/i.test(e.text))headings.push(e);
      }
      if(headings.length)break;
    }
    const scope=unique([...row,...headings]);
    return {columns:unique(cols),row:unique(row),headings:unique(headings),scope,
      taxLevels:[[{source:`${q.source.sheet}!${tier.sourceCell} 档位`,text:tier.label}],unique(cols),unique(row),
        [{source:'渠道名称',text:q.channelName}],unique(headings),[{source:'工作表名称',text:q.source.sheet}]],
      cargo:unique([...row,{source:'渠道名称',text:q.channelName},...headings,{source:'工作表名称',text:q.source.sheet}])};
  }
  fixedFee(tier:RateTier){
    const h=this.header(tier),r=rowNumber(tier.sourceCell);
    const header=(this.rows.get(h.row)??[]).find(c=>/处理费|挂号费|操作费/.test(text(c)));
    if(!header)return null;
    const amount=this.get(r,column(header.coord));
    if(Number(cellValue(amount))!==tier.fixedFee)return null;
    const label=text(header),basis=/[/每]票|一票/.test(label)?'shipment':/[/每]件|一件/.test(label)?'piece':null;
    const zone=this.get(h.row+1,column(header.coord));
    const zoneLabel=/^分区\s*\d+$/.test(text(zone))?text(zone):null;
    return basis?{basis,label,amount:tier.fixedFee!,zoneLabel,evidence:[this.evidence(header)!,this.evidence(amount)!,...(zoneLabel?[this.evidence(zone)!]:[])]}:null;
  }
}

export type Tax = {mode:string;duty:string;vat:string;settlement:string;kind:string;evidence:string;conflict:boolean};
const european=(q:Quote)=>['GB','EU','DE','FR','IT','ES','PL','CZ'].includes(q.countryCode)||/欧洲|欧盟|英国/.test(q.source.sheet+' '+q.channelName);
function taxSignal(raw:string,europe:boolean,basis:string){
  // A CBM-only tax label must not label the KG price to its right.
  const value=raw.split('\n').filter(s=>!(basis==='kg'&&/按方.*(?:包税|递延)/.test(s))&&!(basis==='cbm'&&/按公斤.*(?:包税|递延)/.test(s))).join('\n');
  const excluded=/不包税|不含税|未含税|非包税|税费另计|税金另计|不含关税|关税另计/.test(value);
  const included=/包税|含税/.test(value.replace(/不包税|不含税|未含税|非包税/g,''));
  const deferred=/递延|\bPVA\b/i.test(value);
  const self=/自税|VAT直缴|直缴VAT|自有VAT|自带VAT/i.test(value)||(europe&&/(?:-|—)VAT\b/i.test(value));
  const duty=/不含关税|关税另计/.test(value)?'excluded':/含关税|关税已含/.test(value)?'included':'unknown';
  const vat=/(?:不含|未含)\s*VAT|VAT\s*(?:不含|另计)/i.test(value)?'excluded':/(?:包含|含)\s*VAT|VAT\s*已含/i.test(value)?'included':'unknown';
  return {excluded,included,deferred,self,duty,vat,signal:excluded||included||deferred||self||duty!=='unknown'||vat!=='unknown'};
}
export function resolveTax(q:Quote,levels:Evidence[][]):Tax{
  for(const [levelIndex,level] of levels.entries()){
    const signals=level.map(e=>({e,s:taxSignal(e.text,european(q),q.billingBasis)})).filter(x=>x.s.signal);
    if(!signals.length)continue;
    const included=signals.some(x=>x.s.included),excluded=signals.some(x=>x.s.excluded);
    const deferred=signals.some(x=>x.s.deferred),self=signals.some(x=>x.s.self);
    let duty=signals.find(x=>x.s.duty!=='unknown')?.s.duty??'unknown';
    let vat=signals.find(x=>x.s.vat!=='unknown')?.s.vat??'unknown';
    const evidence=signals.map(x=>`${x.e.source}：${x.e.text}`).join('\n');
    // Mixed headings are only a fallback: the next level may identify this row.
    if((included&&excluded)||(included&&(deferred||self))){
      if(levelIndex>=2)return {mode:'conditional',duty,vat:'unknown',settlement:'alternatives',kind:'explicit',evidence,conflict:true};
      continue;
    }
    if(deferred||self){
      return {mode:'conditional',duty,vat:'excluded',settlement:deferred&&self?'deferred_or_customer_tax':deferred?'deferred':'customer_tax',kind:'explicit',evidence,conflict:false};
    }
    const mode=excluded?'excluded':included?(vat==='excluded'||duty==='excluded'?'partial':'included'):duty==='included'&&vat==='excluded'?'partial':'conditional';
    return {mode,duty,vat,settlement:'unknown',kind:'explicit',evidence,conflict:false};
  }
  const mixed=levels.flat().filter(e=>{
    const s=taxSignal(e.text,european(q),q.billingBasis);return (s.included&&(s.excluded||s.deferred||s.self));
  });
  if(mixed.length)return {mode:'conditional',duty:'unknown',vat:'unknown',settlement:'alternatives',kind:'explicit',evidence:mixed.map(e=>`${e.source}：${e.text}`).join('\n'),conflict:true};
  return {mode:'included',duty:'unknown',vat:'unknown',settlement:'unknown',kind:'business_default',evidence:TAX_POLICY,conflict:false};
}
export function summarizeTax(taxes:Tax[]):Tax{
  const same=(key:keyof Tax)=>new Set(taxes.map(t=>t[key])).size===1;
  return {mode:same('mode')?taxes[0].mode:'conditional',duty:same('duty')?taxes[0].duty:'unknown',vat:same('vat')?taxes[0].vat:'unknown',
    settlement:same('settlement')?taxes[0].settlement:'tier_specific',kind:same('kind')?taxes[0].kind:'mixed',
    evidence:[...new Set(taxes.map(t=>t.evidence))].join('\n'),conflict:taxes.some(t=>t.conflict)};
}
export type Cargo = {type:string;acceptance:string;evidenceKind:string;evidence:string;conditions:string[]};
export function resolveCargo(q:Quote,evidence:Evidence[]):Cargo[]{
  const patterns:Record<string,RegExp>={general:/普货/,battery:/带电|内置电(?:池|产品)?|配套电池|纽扣电池/,magnetic:/带磁|强磁|弱磁/,pure_battery:/纯电|纯电池/,
    liquid:/液体|液粉膏/,powder:/粉末|液粉膏/,sensitive:/敏感|特货|杂货/,health_supplement:/保健品/};
  const result:Cargo[]=[];
  for(const [type,pattern] of Object.entries(patterns)){
    const matches=evidence.flatMap(e=>e.text.replace(/[，,](?=(?:不接|不收|拒收|禁收|禁运|不能|不可|禁止|可发|可接|可收|承接|允许|支持|其他产品))/g,';')
      .split(/[。；;\n]/).filter(s=>pattern.test(s)).map(s=>({e,s})));
    if(!matches.length)continue;
    const forbidden=matches.filter(({s})=>/不接|不收|拒收|禁收|禁运|不能|不可|禁止/.test(s));
    const accepted=matches.filter(({e,s})=>/可发|可接|可收|承接|允许|支持|专用|只接|仅接|只出|仅出|带电普货|(?:带电|带磁|带电带磁)(?:免加收|无附加费)/.test(s)
      ||['渠道名称','工作表名称'].includes(e.source)||s.length<90&&/专线|渠道|海派|空派|快线/.test(s)||/^(普货|敏感货|带电|带磁)$/.test(s.trim()));
    let acceptance=forbidden.length?'forbidden':accepted.length?'allowed':'unknown';
    if(forbidden.length&&accepted.some(x=>!forbidden.includes(x)))acceptance='conditional';
    if(acceptance==='allowed'&&accepted.some(x=>/需|提供|鉴定|认证|加收|\+\s*\d|低于|不超|功率|纽扣电池/.test(x.s.replace(/免加收|无附加费/g,''))))acceptance='conditional';
    if(acceptance!=='forbidden'&&matches.some(x=>/详询|单询|另询|询价|纽扣电池|功率不超/.test(x.s)))acceptance='conditional';
    const onlyGeneral=evidence.find(e=>!['渠道名称','工作表名称'].includes(e.source)&&/只出普货|仅出普货|只接普货|仅接普货/.test(e.text));
    if(type==='sensitive'&&onlyGeneral){acceptance='forbidden';matches.push({e:onlyGeneral,s:onlyGeneral.text});}
    result.push({type,acceptance,evidenceKind:acceptance==='unknown'?'unknown':'explicit',evidence:matches.map(x=>`${x.e.source}：${x.s}`).join('\n'),
      conditions:acceptance==='conditional'?matches.map(x=>x.s):[]});
  }
  // The old normalizer appended general to every channel, including sensitive-only
  // products. Do not turn that implementation default into a business review task.
  if(!result.some(c=>c.acceptance==='allowed'||c.acceptance==='conditional')&&!result.some(c=>c.type==='general'))
    result.push({type:'general',acceptance:'unknown',evidenceKind:'unknown',evidence:'原表未明确通用普货承运范围',conditions:[]});
  return result;
}
export function scopedFees(evidence:Evidence[]){
  const fees:{code:string;label:string;amount:number;currency:string;basis:string;conditions:Record<string,unknown>;evidence:string;prefixes:string[]}[]=[];
  for(const e of evidence){
    const lift=e.text.match(/收件人无卸货能力\s*需额外支付\s*(\d+(?:\.\d+)?)\s*美[金元]\s*\/票尾板费/);
    if(lift)fees.push({code:'liftgate',label:'无卸货能力尾板费',amount:Number(lift[1]),currency:'USD',basis:'shipment',conditions:{recipient_can_unload:false},evidence:`${e.source}：${lift[0]}`,prefixes:[]});
    const residential=e.text.match(/(\d{1,3}(?:[、,，]\d{1,3})*)开头邮编住宅地址需额外加收\s*(\d+(?:\.\d+)?)\s*美[金元]\s*\/票住宅地址费/);
    if(residential)fees.push({code:'residential',label:'指定邮编住宅地址费',amount:Number(residential[2]),currency:'USD',basis:'shipment',
      conditions:{address_type:'residential',postal_prefixes:residential[1].split(/[、,，]/)},evidence:`${e.source}：${residential[0]}`,prefixes:residential[1].split(/[、,，]/)});
  }
  return [...new Map(fees.map(f=>[JSON.stringify([f.code,f.amount,f.conditions]),f])).values()];
}
