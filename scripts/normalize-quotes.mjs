/** Offline adapter pipeline. Source workbooks are never shipped to the browser. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { warehouseCodesFrom } from './warehouse-codes.mjs';

const input = process.argv[2] || 'analysis/latest-extract.json';
const output = 'public/data';
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const quotes = [];
const coverage = [];
const seen = new Set();
const providers = [
  ['鸿莱', 'honglai', '广东鸿莱'], ['梁鑫', 'liangxin', '梁鑫国际'],
  ['枫舟', 'fengzhou', '枫舟供应链'], ['加捷达', 'jiajieda', '加捷达国际'],
  ['领航锦运', 'linghang', '领航锦运'], ['领讯', 'lingxun', '领讯物流'],
  ['欧广', 'ouguang', '欧广云硕'], ['全球顺', 'quanqiushun', '全球顺集运'],
  ['星航', 'xinghang', '星航物流'], ['壹号', 'yihao', '壹号小包'],
  ['亿阳', 'yiyang', '亿阳国际'], ['英美', 'yingmei', '英美跨境'],
  ['衡璇', 'hengxuan', '浙江衡璇'], ['中航', 'zhonghang', '中航环球'],
  ['卓凡', 'zhuofan', '卓凡国际'],
];
const countries = [['加拿大','CA'],['墨西哥','MX'],['英国','GB'],['德国','DE'],['法国','FR'],['意大利','IT'],['西班牙','ES'],['波兰','PL'],['捷克','CZ'],['巴西','BR'],['澳大利亚','AU'],['美国','US']];
const skipSheet = /目录|首页|封面|船期|查询|快捷|快查|自助查价|卡派价格汇总表|商私卡价格汇总表|^汇总$|^渠道汇总$|通讯|联系|地址库|附加|费用说明|赔偿|赔付|须知|必读|协议|产品目录|注意事项|禁寄|反倾销|操作费|偏远|分区|对照表|申报|更新|变动通知|渠道代码|下单代码|ERP|服务规则|仓库操作|增值服务|换单服务|退件服务|^Sheet\d*$/i;
const clean = x => String(x ?? '').replace(/\u200b/g,'').replace(/\r/g,'').trim();
const val = c => c?.formula ? c.cached ?? null : c?.value ?? null;
const text = c => clean(val(c));
const col = ref => [...ref.match(/^[A-Z]+/)[0]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const letter = n => {let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
const numeric = x => typeof x==='number'&&Number.isFinite(x)?x:/^\d+(?:\.\d+)?$/.test(clean(x))?Number(x):null;
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,16);

function sheetAccess(sheet) {
  const cells = new Map(sheet.head.flatMap(r=>r.cells.map(c=>[c.coord,c])));
  const merges = (sheet.merged_ranges||[]).map(range=>{
    const [a,b]=range.split(':');if(!b)return null;
    return {r1:Number(a.match(/\d+/)[0]),r2:Number(b.match(/\d+/)[0]),c1:col(a),c2:col(b),anchor:a};
  }).filter(Boolean);
  const get=(r,c)=>{const ref=letter(c)+r;if(cells.has(ref))return cells.get(ref);const m=merges.find(m=>r>=m.r1&&r<=m.r2&&c>=m.c1&&c<=m.c2);return m?cells.get(m.anchor):undefined;};
  return {cells,get,rows:sheet.head};
}
function parseTier(value, special=false) {
  const raw=clean(value),s=raw.toUpperCase().replace(/[～—–至]/g,'-').replace(/公斤|千克/g,'KG').replace(/立方米|立方/g,'CBM').replace(/\s/g,'');
  if(raw.length>65 || /首重|续重|加收|超过.*加|不足.*按/.test(raw))return null;
  if(special&&/财务结算价.*[方]|按方算/.test(raw))return {label:raw,basis:'cbm',min:Number(raw.match(/([\d.]+)方起/)?.[1]??0),max:null};
  if(/体积结算|材积结算/.test(raw))return null; // Equivalent kg is not physical kg.
  const stripped=s.replace(/(?:材积|体积)\/除?[568]000/g,'').replace(/[\/除][568]000/g,'');
  const basis=/CBM|M³|M3|方/.test(stripped)?'cbm':/KG/.test(stripped)?'kg':null;
  if(!basis)return null;
  let m=stripped.match(/(\d+(?:\.\d+)?)(?:KG|CBM)?-(\d+(?:\.\d+)?)(?:KG|CBM|方)/);
  if(m)return {label:raw,basis,min:Number(m[1]),max:Number(m[2])};
  m=stripped.match(/(\d+(?:\.\d+)?)(?:KG|CBM|方)(?:\+|以上|起|$)/);
  if(m)return {label:raw,basis,min:Number(m[1]),max:null};
  if(special&&/^(?:材积|体积)[/除][568]000/.test(s))return {label:raw,basis:'kg',min:0,max:null};
  return null;
}
function inferCountry(label, title, filename) {
  const matches=countries.filter(([name])=>label.includes(name)).map(([,code])=>code);
  if(matches.length)return matches;
  if(/美转加|加拿大/.test(title)||/枫舟|加捷达|加拿大/.test(filename))return ['CA'];
  const t=title+' '+filename;
  for(const [name,code]of countries)if(title.includes(name))return [code];
  if(/欧洲|欧英|欧美/.test(title))return ['EU'];
  if(/美西|美东|美中|洛杉矶|纽约|芝加哥|休斯|萨凡纳|美森|美线|美国|奥克兰|西雅图|盐田卡派/.test(t))return ['US'];
  for(const [name,code]of countries)if(filename.includes(name))return [code];
  if(/枫舟|加捷达/.test(filename))return ['CA'];
  if(/梁鑫|欧广/.test(filename))return ['US'];
  if(/欧洲|欧加|卓凡/.test(filename))return ['EU'];
  return ['OTHER'];
}
function modeOf(name,file) {
  const t=name+' '+file;
  if(/卡航|卡班|汽运/.test(name))return 'road';
  if(/铁路|铁运/.test(name))return 'rail';
  if(/空运|空派|空卡/.test(t))return 'air';
  if(/海运|海派|海卡|普船|美森|卡派|美转加|直航|EXX|OA|海铁|合德|以星|集运|商卡|自提|纽约|芝加哥|洛杉矶|加拿大海/.test(name))return 'sea';
  if(/小包|壹号|领讯|一件代发/.test(t))return 'parcel';
  if(/UPS|DHL|FEDEX|快递|红单/i.test(name))return 'express';
  if(/美国海运|梁鑫|枫舟|加捷达|亿阳|加拿大|衡璇|英美跨境-.*美线/.test(file))return 'sea';
  return 'unknown';
}
function dateOf(f) {
  let m=f.match(/(202\d)[年.\-]?(\d{1,2})[月.\-]?(\d{1,2})/);
  if(!m){m=f.match(/(?:^|[^\d])(26)[.](\d{1,2})[.](\d{1,2})/);if(m)m[1]='2026';}
  if(!m){m=f.match(/(\d{1,2})[月.\-](\d{1,2})(?:号|日|\s|\.|更新)/);if(m)m=[m[0],'2026',m[1],m[2]];}
  const date=m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:null;
  const tm=f.match(/(\d{1,2})[：:](\d{2})/);
  return {priceDate:date,effectiveAt:date&&/生效|执行/.test(f)?`${date}T${tm?tm[1].padStart(2,'0'): '00'}:${tm?.[2]||'00'}:00+08:00`:null,dateKind:date?(/生效|执行/.test(f)?'explicit':'filename'):'unknown'};
}
function cargoOf(title) {
  const types=['general'];let explicit=/普货|带电|纯电|敏感|特货|杂货|液体|粉末|带磁/.test(title);
  if(/纯电/.test(title))return {types:['pure_battery','sensitive'],certainty:'explicit'};
  if(/带电/.test(title)&&!/不(?:接|收|可)?带电|不可带电|不带电/.test(title))types.push('battery');
  if(/带磁/.test(title)&&!/不(?:接|收)?带磁/.test(title))types.push('magnetic');
  if(/敏感|特货|杂货/.test(title))types.push('sensitive');
  if(/液体/.test(title)&&!/不接.*液体/.test(title))types.push('liquid');
  if(/粉末/.test(title)&&!/不接.*粉末/.test(title))types.push('powder');
  return {types,certainty:explicit?'explicit':'inferred'};
}
function safeNotes(sheet,access,start,end) {
  const result=[];const seen=new Set();
  for(const r of sheet.head){
    if(r.row<start || r.row>end)continue;
    for(const c of r.cells){const t=text(c);if(t.length<35||t.startsWith('=')||/开户行|银行账|收款账号|电话：|联系人：/.test(t))continue;
      if(!seen.has(t)){seen.add(t);result.push(`${c.coord}：${t}`);}}
  }
  return result.slice(0,35);
}
function channelTitle(sheet, access, headerRow, firstColumn = Number.POSITIVE_INFINITY, dataRow = null) {
  const candidateText=value=>{
    let t=clean(value).replace(/^下单渠道[:：]?\s*/, '').trim().split('\n').find(line=>line.trim())?.trim()||'';
    if(!t||t.length<3||t.length>=120)return '';
    if(/有限公司|地址：|返回|体积|材积|重量|交货|地区|区域|更新|渠道代码|^[\d.]+/.test(t))return '';
    if(/^(?:下单渠道|渠道名称|渠道代码|仓库代码|仓库编码|邮编|分区|区域|地区|国家|重量段|计费方式|备注|时效|按方(?:算)?(?:不包税|包税)|不包税|包税|递延|自税)$/i.test(t))return '';
    return /海|空|铁路|卡航|快线|专线|敏感|普货|美森|OA|EXX|UPS|递延|包税|渠道|代发/i.test(t)?t:'';
  };
  const rowCandidate=row=>{
    const cells=sheet.head.find(x=>x.row===row)?.cells||[];
    return cells.filter(c=>col(c.coord)<=firstColumn).sort((a,b)=>col(b.coord)-col(a.coord)).map(c=>candidateText(text(c))).find(Boolean)||'';
  };
  // 亿阳/英美 place a channel column beside the destination, often merged
  // vertically through a price block. Resolve that column at the data row.
  if(dataRow!=null&&access){
    for(let r=headerRow;r>=Math.max(1,headerRow-3);r--){
      const labelCells=(sheet.head.find(x=>x.row===r)?.cells||[]).filter(c=>col(c.coord)<firstColumn&&/^(?:下单渠道|渠道名称|渠道)$/.test(text(c)));
      for(const c of labelCells.sort((a,b)=>col(b.coord)-col(a.coord))){
        for(let rr=dataRow;rr>headerRow;rr--){const candidate=candidateText(text(access.get(rr,col(c.coord))));if(candidate)return candidate;}
      }
    }
  }
  for(let r=headerRow-1;r>=Math.max(1,headerRow-5);r--){
    const cells=sheet.head.find(x=>x.row===r)?.cells||[];
    // Keep independent side-by-side quote blocks attached to their own title.
    const candidate=rowCandidate(r);
    if(candidate)return candidate;
  }
  const onHeader=rowCandidate(headerRow);if(onHeader)return onHeader;
  if(dataRow!=null){const onData=rowCandidate(dataRow);if(onData)return onData;}
  return sheet.name.trim();
}
function variantAt(access,row,column) {
  let origin='',variant='';
  for(let r=row-1;r>=Math.max(1,row-4);r--){const t=text(access.get(r,column));if(!t||t.length>45)continue;
    if(!origin&&!/地址|公司|联系人|电话|价格目录|街道|工业园|栋|室|下单渠道/.test(t)){
      const locations=t.match(/华东|义乌|华南|深圳|上海|广州|宁波|全国|福州|厦门|泉州|合肥|郑州|温州|青岛|临沂|天津|武汉|南京|杭州/g);
      if(locations)origin=[...new Set(locations)].join('/');
    }
    if(!variant&&/不包税|包税|递延|自税|普货|带电|纯电|首重|续重/.test(t))variant=t;
  }
  return {origin,variant};
}
function makeQuote(file,sheet,access,args){
  const p=providers.find(([match])=>file.name.includes(match))||['',hash(file.name),'其他代理'];
  const {title,label,basis,tiers,row,headerRow,variant='',origin='',noteEnd=500,reviewReasonsExtra=[]}=args;
  const cargo=cargoOf(title+' '+variant);
  const cargoEvidence=[];
  if(p[1]==='honglai'&&/敏感线/.test(title)){
    const acceptance=sheet.head.flatMap(r=>r.cells).find(c=>/可接[：:]/.test(text(c)));
    const accepted=text(acceptance).split(/不接[：:]/)[0];
    if(accepted){
      for(const [name,type]of [['带电','battery'],['带磁','magnetic'],['液体','liquid']])if(accepted.includes(name))cargo.types.push(type);
      cargoEvidence.push(`${acceptance.coord}明确可接货品及附加费见原文；同页通用禁限条款须出货前核实`);
    }
  }
  const notes=safeNotes(sheet,access,Math.max(1,headerRow-1),noteEnd);
  const notesText=notes.join('\n');
  const wh=warehouseCodesFrom(label);
  const postalRanges=[...label.matchAll(/(\d{5})\s*[-–—~至]\s*(\d{5})/g)].map(m=>({start:m[1],end:m[2]}));
  const postalCodes=[...new Set(label.replace(/\d{5}\s*[-–—~至]\s*\d{5}/g,'').match(/\b\d{5}\b/g)||[])];
  let postalPrefixes=[];
  if(/邮编开头|邮编前缀/.test(sheet.head.filter(r=>r.row===headerRow).flatMap(r=>r.cells.map(text)).join(' ')))postalPrefixes=[...new Set(label.match(/\b\d{1,3}\b/g)||[])];
  const context=sheet.head.slice(0,25).flatMap(r=>r.cells.map(text)).join(' ');
  const explicitCurrency=/RMB\s*\/\s*KG|人民币|CNY|元\s*\/\s*(KG|公斤|方)/i.test(context);
  const status=/暂停|关停|停航|停收/.test(sheet.name+' '+title)?'suspended':sheet.state!=='visible'?'needs_review':reviewReasonsExtra.length?'needs_review':'reference';
  const reviewReasons=[...reviewReasonsExtra,...cargoEvidence];
  if(!explicitCurrency)reviewReasons.push('币种按国内采购表人民币语境展示，出货前核对');
  if(sheet.state!=='visible')reviewReasons.push('原工作表隐藏，当前可用性需确认');
  if(/标红|红色|黄色|绿色/.test(notesText))reviewReasons.push('原表含按颜色区分的仓点条件，请核对对应原表');
  if(sheet.requires_deeper_read)reviewReasons.push('较长附表采用分块提取，覆盖范围见数据源详情');
  let volumetricDivisor=Number(notesText.match(/(?:材积|材质|体积)[^\n]{0,35}?(?:\/|除)([568]000)/)?.[1])||null;
  if(p[1]==='zhonghang'&&basis==='kg'&&/6000/.test(tiers.map(t=>t.label).join(' ')))volumetricDivisor=6000;
  // Only channel-specific, unambiguous minima are promoted; all other restrictions remain evidence.
  let minCbm=basis==='cbm'?Math.min(...tiers.filter(t=>t.min!==null).map(t=>t.min)):null;
  if(!Number.isFinite(minCbm))minCbm=null;
  if(basis==='cbm'&&p[1]==='zhonghang'&&/义乌|特价/.test(title))minCbm=/义乌/.test(title)?1:5;
  let densityConversionKgPerCbm=null;
  if(basis==='cbm'&&p[1]==='zhonghang'&&/实[际]?重(?:量)?\s*\/\s*500\s*\*\s*167/.test(notesText))densityConversionKgPerCbm=500;
  if(basis==='cbm'&&p[1]==='linghang'&&/1CBM[：:]350KG/.test(notesText))densityConversionKgPerCbm=350;
  if(basis==='cbm'&&p[1]==='zhonghang'&&densityConversionKgPerCbm===null)reviewReasons.push('本渠道原表未说明可继承的1:500密度换算，未套用其它渠道限制');
  const transitCell=(sheet.head.find(r=>r.row===row)?.cells||[]).find(c=>/\d+(?:[-~至]\d+)?(?:个)?(?:自然|工作)?(?:日|天).*(?:签收|提取|送仓|到|POD)|开船后.*天/.test(text(c))&&text(c).length<600);
  const transit=transitCell?text(transitCell):'';
  for(const countryCode of inferCountry(label,title+' '+sheet.name,file.name)){
    const id=hash([file.id,sheet.name,row,headerRow,basis,variant,origin,countryCode,tiers.map(t=>t.sourceCell).join(',')].join('|'));
    if(seen.has(id))continue;seen.add(id);
    quotes.push({id,providerId:p[1],providerName:p[2],isOwn:p[1]==='zhonghang',channelName:[title,variant].filter(Boolean).join(' · '),countryCode,mode:modeOf(title+' '+sheet.name,file.name),delivery:wh.length?'amazon':/住宅|私人/.test(label)?'residential':/商业|商卡/.test(title+' '+label)?'commercial':'all',origin:origin||(/华东|东中华北/.test(file.name)?'华东/东中/华北':/义乌/.test(title)?'义乌':/华南/.test(file.name)?'华南':'按原表交仓'),destinationLabel:label,warehouseCodes:wh,postalPrefixes,postalRanges,postalCodes,cargoTypes:[...new Set(cargo.types)],cargoCertainty:cargo.certainty,billingBasis:basis,currency:'CNY',currencyEvidence:explicitCurrency?'explicit':'context',tiers,volumetricDivisor,minShipmentKg:null,minPieceKg:null,minCbm,maxKgPerCbm:null,densityConversionKgPerCbm,volumeEquivalentKgPerCbm:densityConversionKgPerCbm===500?167:null,transitText:transit,notes,...dateOf(file.name),status,reviewReasons,reliability:{level:'unknown',note:'尚未录入公司实际走货反馈；表内时效为代理参考口径'},source:{fileId:file.id,fileName:file.name,sheet:sheet.name,cells:[...new Set(tiers.map(t=>t.sourceCell))],hidden:sheet.state!=='visible'}});
  }
}

function horizontal(file,sheet,access){
  const headers=[];
  for(const row of sheet.head){
    const entries=row.cells.map(c=>({c:col(c.coord),tier:parseTier(text(c),true),cell:c})).filter(x=>x.tier);
    const texts=row.cells.map(text).join(' ');
    if(row.cells.some(c=>numeric(val(c))!==null&&!entries.some(e=>e.c===col(c.coord))))continue;
    if(entries.length && (entries.length>=2||/仓库|国家|区域|地区|邮编|时效|按方|结算|公斤|重量|价格|KG\+|CBM\+/i.test(texts))&&!/^\d+[.、]/.test(texts))headers.push({row:row.row,entries});
  }
  for(let hi=0;hi<headers.length;hi++){
    const h=headers[hi];
    let end=headers[hi+1]?.row??(Math.max(0,...sheet.head.map(r=>r.row))+1);
    // Fee tables cannot inherit the preceding freight block's kg/cbm headers.
    const feeSection=/^(?:卸货费|装卸费|入库特殊操作费|入库操作费|出库操作费|仓储费|附加费|增值服务费|海外仓操作费)$/;
    const feeHeader=/^(?:收费项(?:目)?|入库方式|出库方式|收费标准|收费单位|计费单位|带托价格|不带托价格)$/;
    for(const row of sheet.head){
      if(row.row<=h.row||row.row>=end)continue;
      const values=row.cells.map(text).filter(Boolean);
      const normalized=values.map(v=>v.split('\n')[0].trim());
      const section=normalized.some(v=>feeSection.test(v))&&values.length<=3;
      const header=normalized.some(v=>feeHeader.test(v))&&normalized.some(v=>/^(?:规格|价格|收费标准|计费单位|单位|备注|入库方式|带托价格|不带托价格)$/.test(v));
      if(section||header){end=row.row;break;}
    }
    const groups=[];
    for(const e of h.entries){
      const v=variantAt(access,h.row,e.c);let g=groups.at(-1),last=g?.entries.at(-1);
      const reset=last&&e.tier.min!==null&&last.tier.min!==null&&e.tier.min<=last.tier.min;
      if(!g||g.basis!==e.tier.basis||reset||g.origin!==v.origin||g.variant!==v.variant){g={basis:e.tier.basis,...v,entries:[]};groups.push(g);}g.entries.push(e);
    }
    for(let r=h.row+1;r<end;r++){
      const rawRow=sheet.head.find(x=>x.row===r);if(!rawRow)continue;
      const first=Math.min(...h.entries.map(e=>e.c));
      for(const g of groups){
        const gc=g.entries[0].c;
        const priorDestination=sheet.head.find(x=>x.row===h.row)?.cells.filter(c=>col(c.coord)<gc&&/^(?:国家|仓库|仓码|邮编|区域|地区|服务区域)/.test(text(c))).at(-1);
        const dc=priorDestination?col(priorDestination.coord):1;
        const upper=dc>=first?gc:first;
        const labels=[];for(let c=dc;c<upper;c++){const t=text(access.get(r,c));if(t&&!t.startsWith('=')&&!labels.includes(t))labels.push(t);}
        const label=labels.join(' / ');
        if(!label||label.length>1800||/^(?:备注|计费方式|操作说明|注意事项|渠道代码|下单渠道|发货|赔偿|截单|时效|附加|包装|\d+[.、])/.test(label))continue;
        if(label.length>150&&!/[A-Z]{2,4}\d|\b\d{5}\b/.test(label))continue;
        let tiers=g.entries.map(e=>{
          const cell=access.get(r,e.c),raw=val(cell),price=numeric(raw);let status=price!==null?'priced':/停|拒收|无服务/.test(clean(raw))?'unavailable':'inquiry';
          if(price!==null&&(price<0||price>200000))return null;
          if(raw===null||raw==='')return null;
          if(price===null&&!/^[-—*\/]+$|询|停|无服务|不收|不接|拒收/.test(clean(raw)))return null;
          return {...e.tier,price,status,sourceCell:cell?.coord||letter(e.c)+r,minInclusive:true,maxInclusive:e.tier.max!==null};
        }).filter(Boolean);
        if(!tiers.length||!tiers.some(t=>t.price!==null))continue;
        tiers=tiers.map((t,i)=>{const next=tiers[i+1];if(t.max===null&&t.min!==null&&next?.min>t.min)return {...t,max:next.min,maxInclusive:false};return t;});
        const title=channelTitle(sheet,access,h.row,Math.min(...g.entries.map(e=>e.c)),r);
        const suspiciousCbm = g.basis==='cbm' && tiers.some(t=>t.price!==null && t.price<100 && /CBM|方/i.test(t.label));
        const reviewReasonsExtra = suspiciousCbm
          ? [`CBM阶梯单价${tiers.filter(t=>t.price!==null&&t.price<100).map(t=>t.price).join('/')}偏低，保留原单元格数值但未按方价换算；请核对${tiers.find(t=>t.price!==null&&t.price<100)?.sourceCell||'原表'}`]
          : [];
        makeQuote(file,sheet,access,{title,label,basis:g.basis,tiers,row:r,headerRow:h.row,variant:g.variant,origin:g.origin,noteEnd:end-1,reviewReasonsExtra});
      }
    }
  }
}
function vertical(file,sheet,access){
  // Small parcel adapters: weight band in rows, RMB/kg and fixed per-parcel handling fee in columns.
  for(const header of sheet.head){
    const weight=header.cells.find(c=>/重量段|重量区间|重量分区|重量范围/.test(text(c)));
    const rate=header.cells.find(c=>/RMB\s*\/\s*KG|运费.*KG|运费.*公斤/i.test(text(c)));
    if(!weight||!rate)continue;
    const fee=header.cells.find(c=>/处理费|挂号费|操作费/.test(text(c)));
    const wc=col(weight.coord),rc=col(rate.coord),fc=fee?col(fee.coord):null;
    const title=channelTitle(sheet,access,header.row);
    const groups=new Map();
    for(let r=header.row+1;r<=Math.max(0,...sheet.head.map(row=>row.row));r++){
      const wt=text(access.get(r,wc));
      if(r>header.row+2&&/重量段|重量区间/.test(wt))break;
      const normalizedWeight=wt.replace(/\(首重.*?\)|（首重.*?）/,'');
      const tier=parseTier(/KG|公斤/i.test(normalizedWeight)?normalizedWeight:`${normalizedWeight}KG`);
      const price=numeric(val(access.get(r,rc)));
      if(!tier||tier.basis!=='kg'||price===null)continue;
      const left=[];for(let c=1;c<wc;c++){const t=text(access.get(r,c));if(t&&!left.includes(t))left.push(t);}
      const label=left.join(' / ')||title;
      const key=label; if(!groups.has(key))groups.set(key,[]);
      const fixedFee=fc?numeric(val(access.get(r,fc))):null;
      groups.get(key).push({...tier,price,status:'priced',sourceCell:access.get(r,rc)?.coord||letter(rc)+r,minInclusive:true,maxInclusive:true,...(fixedFee!==null?{fixedFee}: {})});
    }
    for(const [label,tiers]of groups)makeQuote(file,sheet,access,{title:label.length<80?`${sheet.name} · ${label}`:title,label,basis:'kg',tiers,row:Number(tiers[0].sourceCell.match(/\d+/)[0]),headerRow:header.row});
  }
}

for(const file of source.files){
  const before=quotes.length;const sheets=[];
  for(const sheet of file.sheets||[]){
    const count=quotes.length;
    if(!skipSheet.test(sheet.name)&&!/暂停|关停/.test(sheet.name)){
      const a=sheetAccess(sheet);vertical(file,sheet,a);horizontal(file,sheet,a);
    }
    sheets.push({name:sheet.name,state:sheet.state,rows:sheet.rows,quotes:quotes.length-count,reason:quotes.length>count?'已提取可识别价格区块':skipSheet.test(sheet.name)?'目录/查询公式页/规则或地址参考页':/暂停|关停/.test(sheet.name)?'渠道暂停，未加入报价':'未识别价格表头或仅图片内容，需补充适配',sampled:sheet.requires_deeper_read});
  }
  const p=providers.find(([m])=>file.name.includes(m))||['',hash(file.name),'其他代理'];
  coverage.push({id:file.id,name:file.name,providerId:p[1],providerName:p[2],sha256:file.sha256,sheets:(file.sheets||[]).length,hiddenSheets:(file.sheets||[]).filter(s=>s.state!=='visible').length,quoteCount:quotes.length-before,status:file.readable?'partial':'failed',warnings:['首版按可识别价格区块整理；完整附加费、颜色限制及大邮编库尚未全部计算',...(!file.readable?[file.error]:[])],sheetCoverage:sheets});
}

// Remove parser duplicates created by multiple visual blocks that point to the same
// business row. Keep the first source cell as the evidence anchor.
const uniqueQuotes=[];const uniqueKeys=new Set();
for(const q of quotes){
  const key=JSON.stringify({providerId:q.providerId,channelName:q.channelName,countryCode:q.countryCode,mode:q.mode,delivery:q.delivery,origin:q.origin,destinationLabel:q.destinationLabel,warehouseCodes:q.warehouseCodes,postalPrefixes:q.postalPrefixes,cargoTypes:q.cargoTypes,billingBasis:q.billingBasis,currency:q.currency,tiers:q.tiers.map(({sourceCell,...t})=>t),volumetricDivisor:q.volumetricDivisor,minCbm:q.minCbm,densityConversionKgPerCbm:q.densityConversionKgPerCbm});
  const scopedKey=JSON.stringify([q.source.fileId,q.source.sheet,q.status,q.reviewReasons,q.notes,key]);
  if(!uniqueKeys.has(scopedKey)){uniqueKeys.add(scopedKey);uniqueQuotes.push(q);}
}
quotes.length=0;quotes.push(...uniqueQuotes);
for(const f of coverage){
  const rows=quotes.filter(q=>q.source.fileId===f.id);
  f.quoteCount=rows.length;
  for(const sheet of f.sheetCoverage)sheet.quotes=rows.filter(q=>q.source.sheet===sheet.name).length;
}

// Retain one strict JSON object per route/billing variant; content-addressed chunks avoid mixed versions.
fs.mkdirSync(output,{recursive:true});
for(const existing of fs.readdirSync(output))fs.rmSync(path.join(output,existing),{recursive:false,force:true});
const contentHash=hash(JSON.stringify(quotes));
const releaseDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()).replaceAll('-','.');
const chunks=[];
for(const country of [...new Set(quotes.map(q=>q.countryCode))].sort()){
  for(const providerId of [...new Set(quotes.filter(q=>q.countryCode===country).map(q=>q.providerId))].sort()){
  const rows=quotes.filter(q=>q.countryCode===country&&q.providerId===providerId);
  const rules={};
  const compact=rows.map(({notes,...q})=>{const ruleRef=hash(JSON.stringify(notes));rules[ruleRef]=notes;return {...q,notes:[],ruleRef};});
  const filename=`quotes-${country.toLowerCase()}-${providerId}-${hash(JSON.stringify(compact))}.json`;
  const rulesFilename=`rules-${country.toLowerCase()}-${providerId}-${hash(JSON.stringify(rules))}.json`;
  fs.writeFileSync(path.join(output,filename),JSON.stringify(compact));
  fs.writeFileSync(path.join(output,rulesFilename),JSON.stringify(rules));
  chunks.push({country,providerId,path:filename,rulesPath:rulesFilename,count:rows.length});
  }
}
const catalog={schemaVersion:'1.0',version:`${releaseDay}-${contentHash.slice(0,8)}`,generatedAt:new Date().toISOString(),files:coverage.map(({sheetCoverage,...f})=>f),chunks,stats:{quotes:quotes.length,providers:new Set(quotes.map(q=>q.providerId)).size,countries:new Set(chunks.map(c=>c.country)).size,sources:source.files.length,cbmQuotes:quotes.filter(q=>q.billingBasis==='cbm').length}};
fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(catalog,null,2));
fs.writeFileSync(path.join(output,'coverage.json'),JSON.stringify(coverage,null,2));
console.log(JSON.stringify(catalog.stats));
for(const f of coverage)console.log(`${String(f.quoteCount).padStart(5)}  ${f.name}`);
