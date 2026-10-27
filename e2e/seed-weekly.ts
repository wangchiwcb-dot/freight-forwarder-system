// Run only against an isolated local browser-test database, while its API is stopped.
import { resolve,sep } from 'node:path';
import { connectDatabase,migrate } from '../server/v2/database';
const directory=process.env.E2E_WEEKLY_DATA_DIR;
const allowed=resolve('.local/v2/weekly-tests')+sep;
if(!directory||!resolve(directory).startsWith(allowed)||process.env.DATABASE_URL||process.env.NODE_ENV==='production') throw new Error('周更验收只允许使用 .local/v2/weekly-tests 内的独立本地数据库');
const db=await connectDatabase({localPath:directory});
try {
  await migrate(db);
  for(const [key,name,state] of [['1','[验收] 10月21日旧表.xlsx','legacy'],['2','[验收] 10月28日新表.xlsx','pending'],['3','[验收] 未更新代理.xlsx','legacy'],['4','[验收] 11月4日改名表.xlsx','pending']]) {
    await db.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata,pricing_state)
      VALUES($1,$1,$2,0,'unused','unused','extracted','{}',$3)`,[key.repeat(64),name,state]);
  }
  for(const [id,file,channel,unitPrice] of [['weekly-old','1','周更验收渠道 A',10],['weekly-retained','1','周更验收保留渠道',21],['weekly-new','2','周更验收渠道 A',12],['weekly-other','3','周更验收未更新代理',30],['weekly-renamed','4','周更验收渠道 A 改名',14]] as const) {
    const providerName=file==='3'?'未更新验收代理':'周更验收代理';
    const quote={id,providerId:providerName,providerName,isOwn:false,channelName:channel,countryCode:'US',mode:'sea',delivery:'all',origin:'深圳',destinationLabel:'美西',
      warehouseCodes:[],postalCodes:['90001'],postalPrefixes:[],cargoTypes:[],cargoCertainty:'unknown',billingBasis:'kg',currency:'CNY',currencyEvidence:'explicit',
      tiers:[{label:'0kg起',min:0,max:null,minInclusive:true,maxInclusive:false,price:unitPrice,status:'priced',sourceCell:'D10'}],
      volumetricDivisor:6000,minShipmentKg:null,minPieceKg:null,minCbm:null,maxKgPerCbm:null,transitText:'30天',notes:[],priceDate:'2026-10-21',effectiveAt:null,dateKind:'filename',status:'reference',reviewReasons:[],
      source:{fileId:file,fileName:'验收.xlsx',sheet:'美国海派',cells:['D10'],hidden:false}};
    await db.query(`INSERT INTO quotation_v2.price_drafts(id,source_id,source_quote_id,parser_version,provider_hint,channel_hint,country_hint,mode_hint,proposed_data)
      VALUES($1,$2,$1,'test',$3,$4,'US','sea',$5)`,[id,file.repeat(64),providerName,channel,JSON.stringify(quote)]);
  }
  console.log('已建立 4 份验收原表、5 条验收价格；没有操作生产数据库。');
} finally {await db.close();}
