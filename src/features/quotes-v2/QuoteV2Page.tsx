import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber, Radio, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { TRANSPORT_MODES, transportLabels, type TransportMode } from '../../domain/v2/contracts';
import type { PricingRequest } from '../../domain/v2/pricing-contracts';
import type { ComparisonInput, ComparisonItem, ComparisonRun } from '../../domain/v2/comparison-contracts';
import type { PriceDraftRecord, Readiness } from '../../domain/v2/review-contracts';
import { quotationApi as api, countryNames, cargoOptions } from './api';
import { ReviewWorkspace } from './ReviewWorkspace';
import './quotes-v2.css';

const { Text, Title } = Typography;
const initial:PricingRequest={country:'US',origin:'',postalCode:'',warehouseCode:'',addressType:'unknown',cargoAttributes:[],
  intellectualProperty:'unknown',modes:[...TRANSPORT_MODES],asOf:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),measurementStage:'estimated',
  packages:[{id:'box1',pieces:1,actualKg:null,lengthCm:null,widthCm:null,heightCm:null}],actualKg:null,volumeCbm:null,pieces:null,includeExamples:false,trialBilling:null};
const defaultOptions={selectedDraftIds:[],referenceAggregation:'shipment' as const,referenceStep:'0',fallbackDivisor:null};
const price=(amount:string|null,currency:string|null='CNY')=>amount===null?'待核算':`${currency??'币种待核'} ${Number(amount).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const statusText={complete:'完整成本',reference:'参考费用',needs_parameters:'待补参数',inquiry:'需询价',unavailable:'不适用'};

export default function QuoteV2Page() {
  const [form]=Form.useForm();
  const inputMethod=Form.useWatch('inputMethod',form)??'packages';
  const [activeTab,setActiveTab]=useState('calculate');
  const [catalogCountry,setCatalogCountry]=useState('US');
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [selected,setSelected]=useState<ComparisonItem|null>(null);
  const [savedRun,setSavedRun]=useState<ComparisonRun|null>(null);
  const [replaces,setReplaces]=useState<string|null>(null);
  const [historyId,setHistoryId]=useState('');
  const [error,setError]=useState('');
  const [dirty,setDirty]=useState(false);
  const [paging,setPaging]=useState(false);
  const [showUnavailable,setShowUnavailable]=useState(false);
  const pageSequence=useRef(0);
  const resultsRef=useRef<HTMLDivElement>(null);
  const readiness=useQuery({queryKey:['v2-readiness'],queryFn:()=>api<Readiness>('/readiness')});
  const detail=useQuery({queryKey:['v2-draft-detail',selected?.draftId],queryFn:()=>api<PriceDraftRecord>(`/price-drafts/${selected!.draftId}`),enabled:Boolean(selected?.draftId)});
  const calculate=useMutation({mutationFn:(body:ComparisonInput)=>api<ComparisonRun>('/comparisons',body),
    onSuccess:run=>{pageSequence.current++;setSavedRun(run);setDirty(false);setShowUnavailable(false);setError('');requestAnimationFrame(()=>resultsRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));}});
  const submit=(values:Record<string,any>)=>{
    const packages=values.inputMethod==='totals'?[]:(values.packages??[]).map((item:any,index:number)=>({id:`box${index+1}`,pieces:item.pieces??1,
      actualKg:item.actualKg??null,lengthCm:item.lengthCm??null,widthCm:item.widthCm??null,heightCm:item.heightCm??null}));
    const request:PricingRequest={...initial,country:values.country,origin:values.origin??'',postalCode:values.postalCode??'',warehouseCode:values.warehouseCode??'',
      addressType:values.addressType,cargoAttributes:values.cargoAttributes??[],intellectualProperty:values.intellectualProperty,
      modes:values.modes,asOf:values.asOf,measurementStage:values.measurementStage,packages,
      actualKg:values.inputMethod==='totals'?values.actualKg??null:null,volumeCbm:values.inputMethod==='totals'?values.volumeCbm??null:null,pieces:values.inputMethod==='totals'?values.pieces??null:null};
    calculate.mutate({request,options:{...defaultOptions,...values.options,selectedDraftIds:selectedIds},supersedes:replaces});
  };
  async function pageResults(page:number,unavailable=showUnavailable) {
    if(!savedRun)return;const sequence=++pageSequence.current;setPaging(true);setError('');
    try {const run=await api<ComparisonRun>(`/comparisons/${savedRun.id}?page=${page}&showUnavailable=${unavailable}`);if(sequence===pageSequence.current){setSavedRun(run);setShowUnavailable(unavailable);}}
    catch(error){setError((error as Error).message);}finally{if(sequence===pageSequence.current)setPaging(false);}
  }
  async function restore() {
    try {const run=await api<ComparisonRun>(`/comparisons/${encodeURIComponent(historyId.trim())}`);pageSequence.current++;
      form.setFieldsValue({...run.request,inputMethod:run.request.packages.length?'packages':'totals',options:run.options});
      setSelectedIds(run.options.selectedDraftIds);setSavedRun(run);setReplaces(run.id);setShowUnavailable(false);setDirty(false);setError('');
    }catch(error){setError((error as Error).message);}
  }
  const columns:ColumnsType<ComparisonItem>=[
    {title:'代理 / 渠道',key:'channel',width:210,render:(_,row)=><Space direction="vertical" size={2}><Text strong>{row.provider}</Text><Button type="link" className="v2-detail-link" onClick={()=>setSelected(row)}>{row.channel}</Button><Text type="secondary">{transportLabels[row.mode as TransportMode]??'运输方式待核'} · {row.destination}</Text><Text type="secondary">交仓：{row.origin??'待核'}</Text></Space>},
    {title:'单价 / 计费量',key:'unit',width:180,render:(_,row)=>row.unitPrice!==null?<>{price(row.unitPrice,row.currency)}/{row.basis}<br/><Text>计费 {row.quantity?Number(row.quantity).toLocaleString('zh-CN',{maximumFractionDigits:3}):'待核'} {row.basis}</Text><br/><Text type="secondary">{row.tierLabel}</Text></>:<>{row.tiers.slice(0,3).map((tier,index)=><div key={index}>{tier.label}：{tier.price===null?'询价':`${tier.price} ${row.currency??''}/${row.basis}`}</div>)}{row.tiers.length>3&&<Button type="link" onClick={()=>setSelected(row)}>全部档位</Button>}</>},
    {title:'基础运费 / 附加费',key:'base',width:175,render:(_,row)=><Space direction="vertical" size={3}><Text>运费 {price(row.baseFreight,row.currency)}</Text><Text type="secondary">附加费 {row.knownSurcharges===null?row.status==='complete'?'无另收费用':'待核':price(row.knownSurcharges,row.currency)}</Text></Space>},
    {title:'费用合计',key:'cost',width:180,render:(_,row)=><Space direction="vertical" size={3}><Text strong>{row.status==='unavailable'?'不适用':price(row.completeCost??row.knownCost,row.currency)}</Text><Tag color={row.status==='complete'?'green':row.status==='reference'?'blue':'gold'}>{statusText[row.status]}</Tag>{row.lowestComplete?<Tag color="green">同口径最低完整成本</Tag>:row.lowestReference&&<Tag color="cyan">同币种已知费用最低</Tag>}</Space>},
    {title:'时效 / 待核事项',key:'warnings',width:245,render:(_,row)=><><Text>{row.transitText||'时效待核'}</Text><br/>{row.coverage==='unknown'&&<Tag color="gold">目的地覆盖待核</Tag>}<Text type="secondary">{row.warnings[0]}</Text><br/><Button onClick={()=>setSelected(row)}>费用明细与依据</Button></>},
  ];
  return <div className="v2-page">
    <div><Title level={3}>多渠道成本比价</Title><Text type="secondary">输入同一票货物，比较各家代理与自有渠道的成本、附加费和时效。</Text></div>
    {readiness.data&&<Text type="secondary">已接入 {readiness.data.sources} 份报价表 · {readiness.data.priceDrafts.toLocaleString('zh-CN')} 条原表价格 · 海运 / 铁路 / 卡航 / 空运</Text>}
    {readiness.error&&<Alert type="error" message={readiness.error.message}/>}
    <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
      {key:'calculate',label:'货物与费用',children:<>
        <Card title="填写本票货物">
          <Form form={form} layout="vertical" initialValues={{...initial,inputMethod:'packages',options:defaultOptions}} onFinish={submit} onValuesChange={()=>setDirty(true)} requiredMark={false} disabled={calculate.isPending}>
            <div className="v2-form-grid">
              <Form.Item name="country" label="目的国家" rules={[{ required: true }]}><Select options={Object.entries(countryNames).filter(([value]) => !['EU','OTHER'].includes(value)).map(([value,label]) => ({ value,label }))} /></Form.Item>
              <Form.Item name="addressType" label="地址类型"><Select options={[{ value: 'unknown', label: '待确认' }, { value: 'residential', label: '私人地址' }, { value: 'commercial', label: '商业地址' }, { value: 'platform', label: '平台仓库' }]} /></Form.Item>
              <Form.Item name="origin" label="交仓点"><Input placeholder="正式比价需填写交仓点" /></Form.Item>
              <Form.Item name="postalCode" label="目的邮编"><Input /></Form.Item>
              <Form.Item name="warehouseCode" label="目的仓码"><Input /></Form.Item>
              <Form.Item name="asOf" label="适用报价日期" rules={[{ required: true }]}><Input type="date" /></Form.Item>
              <Form.Item name="measurementStage" label="重量和尺寸来源"><Select options={[{ value: 'estimated', label: '客户提供 / 预估数据' }, { value: 'warehouse', label: '入仓测量数据' }]} /></Form.Item>
              <Form.Item name="intellectualProperty" label="侵权仿牌情况"><Select options={[{ value: 'unknown', label: '待确认' }, { value: 'clear', label: '已确认非侵权仿牌' }, { value: 'infringing', label: '侵权仿牌' }]} /></Form.Item>
            </div>
            <Form.Item name="modes" label="运输方式" rules={[{ type: 'array', min: 1, message: '至少选择一种运输方式' }]}><Checkbox.Group options={TRANSPORT_MODES.map(value => ({ value, label: transportLabels[value] }))} /></Form.Item>
            <Form.Item name="cargoAttributes" label="货品属性（无特殊属性时为普货，可补充自定义属性）"><Select mode="tags" options={cargoOptions} /></Form.Item>
            <Form.Item name="inputMethod" label="货物资料填写方式"><Radio.Group options={[{value:'packages',label:'逐箱重量和尺寸'},{value:'totals',label:'整票实重和体积'}]}/></Form.Item>
            <div style={{display:inputMethod==='packages'?'block':'none'}}>
            <Text strong>按包装组填写：同组每箱重量和尺寸相同</Text>
            <div className="v2-package-scroll"><div className="v2-package-head"><span>箱数</span><span>每箱实重 kg</span><span>长 cm</span><span>宽 cm</span><span>高 cm</span><span /></div>
              <Form.List name="packages">{(fields, { add, remove }) => <>
                {fields.map(({ key, name, ...rest }) => <div className="v2-package-row" key={key}>
                  <Form.Item {...rest} name={[name, 'pieces']} rules={[{ required: true, message: '填写箱数' }]}><InputNumber min={1} precision={0} aria-label={`包装组${name + 1}箱数`} /></Form.Item>
                  {(['actualKg', 'lengthCm', 'widthCm', 'heightCm'] as const).map((field, index) => <Form.Item {...rest} key={field} name={[name, field]}><InputNumber stringMode min="0.001" aria-label={`包装组${name + 1}${['实重', '长', '宽', '高'][index]}`} /></Form.Item>)}
                  <Button type="text" aria-label={`删除包装组${name + 1}`} icon={<MinusCircleOutlined />} onClick={() => remove(name)} />
                </div>)}
                <Button icon={<PlusOutlined />} onClick={() => add({ pieces: 1, actualKg: null, lengthCm: null, widthCm: null, heightCm: null })}>添加包装组</Button>
              </>}</Form.List>
            </div>
            </div>
            <div className="v2-form-grid" style={{display:inputMethod==='totals'?'grid':'none'}}>
              <Form.Item name="actualKg" label="整票实重 kg"><InputNumber stringMode min="0.001"/></Form.Item>
              <Form.Item name="volumeCbm" label="整票体积 CBM"><InputNumber stringMode min="0.000001"/></Form.Item>
              <Form.Item name="pieces" label="总件数"><InputNumber min={1} precision={0}/></Form.Item>
            </div>

            <div className="v2-reference-settings">
              <Text strong>未完整核实报价的参考测算设置</Text><p>已建立的渠道规则优先使用。以下参数只用于原表规则尚未补齐的参考费用，不会修改渠道规则。</p>
              <div className="v2-form-grid">
                <Form.Item name={['options','fallbackDivisor']} label="原表缺少材积系数时（选填）"><InputNumber stringMode min="1" placeholder="不填则仅显示单价"/></Form.Item>
                <Form.Item name={['options','referenceAggregation']} label="参考取大方式"><Select options={[{value:'shipment',label:'整票实重与材积重取大'},{value:'piece',label:'每箱取大后相加'}]}/></Form.Item>
                <Form.Item name={['options','referenceStep']} label="参考计费量进位（0为不进位）" rules={[{required:true}]}><InputNumber stringMode min="0"/></Form.Item>
              </div>
            </div>
            <Space wrap><Tag>{selectedIds.length?`仅比价所选 ${selectedIds.length} 条报价`:'比价全部符合国家和运输方式的报价'}</Tag><Button onClick={()=>{setCatalogCountry(form.getFieldValue('country'));setActiveTab('prices');}}>选择报价表中的价格</Button>{selectedIds.length>0&&<Button onClick={()=>{setSelectedIds([]);setDirty(true);}}>改为全部报价</Button>}</Space>
            <div style={{marginTop:18}}><Space wrap><Button type="primary" htmlType="submit" loading={calculate.isPending}>计算各渠道价格</Button><Button onClick={()=>{form.resetFields();setSelectedIds([]);setSavedRun(null);setReplaces(null);setError('');setDirty(false);}}>重置</Button>{replaces&&<Text type="secondary">本次保存为原记录的复算版本</Text>}</Space></div>
            <div role="status" aria-live="polite" className="v2-calculation-status">{calculate.isPending?'正在逐条计算渠道费用…':savedRun?`本次找到 ${savedRun.summary.candidates} 条报价，${savedRun.summary.calculated} 条已算出费用`:''}</div>
          </Form>
        </Card>
        {calculate.error&&<Alert type="error" message={calculate.error.message}/>}
        <div ref={resultsRef}><Card title="各渠道价格比较" extra={savedRun&&<Button onClick={()=>{form.setFieldValue('measurementStage','warehouse');setReplaces(savedRun.id);setDirty(true);form.scrollToField('measurementStage');}}>填写入仓数据复算</Button>}>
          {dirty&&savedRun&&<Alert type="warning" message="货物或比价范围已修改，请重新计算；下方仍为上次结果。"/>}
          {savedRun&&<>
            <p>涉及 {savedRun.summary.providers} 家供应商 / {savedRun.summary.sources} 份报价表；算出费用 {savedRun.summary.calculated} 条，待补参数或询价 {savedRun.summary.needsParameters} 条，不适用 {savedRun.summary.unavailable} 条。</p>
            <Alert type="info" showIcon message="按已知费用由低到高排列，目的地已匹配的渠道优先；不同币种分开比较。" description="参考费用尚未包含全部待核收费，不代表最低最终结算价。缺少材积系数时可在上方填入本次参考值；原表已写明的系数仍优先使用。"/>
            <Checkbox checked={showUnavailable} onChange={event=>void pageResults(1,event.target.checked)}>显示不适用渠道及原因</Checkbox>
          </>}
          <Table<ComparisonItem> rowKey="id" columns={columns} dataSource={savedRun?.items??[]} loading={calculate.isPending||paging} scroll={{x:990}}
            pagination={{current:savedRun?.page??1,pageSize:15,total:savedRun?.total??0,onChange:page=>void pageResults(page),showSizeChanger:false}}
            locale={{emptyText:<Empty description={savedRun?'当前没有可展示报价，请检查国家、运输方式及所选范围，或勾选查看不适用原因':'填写货物资料后，点击“计算各渠道价格”'}/>}}/>
          {savedRun&&<Space direction="vertical"><Text type="secondary">预估报价以入仓实测复算。时效沿用原表口径。</Text><Text copyable>{savedRun.id}</Text></Space>}
          <div className="v2-history"><Input value={historyId} onChange={event=>setHistoryId(event.target.value)} placeholder="粘贴比价记录编号"/><Button onClick={()=>void restore()}>读取记录</Button></div>
          {error&&<Alert type="error" message={error}/>}
        </Card></div>
      </>},
      {key:'prices',label:'原表价格查询',children:<ReviewWorkspace initialCountry={catalogCountry} selectedIds={selectedIds} onCompare={(ids,country)=>{setSelectedIds(ids);form.setFieldValue('country',country);setDirty(true);setActiveTab('calculate');}}/>},
      {key:'rules',label:'渠道规则维护',children:<ReviewWorkspace view="rules"/>},
    ]}/>
    <Drawer title={selected?`${selected.provider} · ${selected.channel}`:''} open={Boolean(selected)} onClose={()=>setSelected(null)} width="min(850px, 100vw)">
      {selected&&<Space direction="vertical" size={16} className="v2-details">
        <Alert type={selected.status==='unavailable'?'error':'info'} message={statusText[selected.status]} description={selected.status==='reference'?'以下为已知费用，待核项目需补齐后才能确认最终成本。':undefined}/>
        <Descriptions column={2} items={[{key:'cost',label:'费用合计',children:price(selected.completeCost??selected.knownCost,selected.currency)},
          {key:'quantity',label:'计费量',children:`${selected.quantity??'待核'} ${selected.basis}`},{key:'transit',label:'时效',children:selected.transitText||'待核'},
          {key:'scope',label:'覆盖范围',children:selected.destination}]}/>
        <Table pagination={false} size="small" rowKey={(_,index)=>String(index)} dataSource={selected.lines} columns={[
          {title:'费用项目',dataIndex:'label'},{title:'数量 × 单价',key:'formula',render:(_,line)=>line.quantity&&line.unitPrice?`${line.quantity} × ${line.unitPrice}`:'—'},
          {title:'金额',key:'amount',render:(_,line)=>line.inclusion==='included'?'已含':line.inclusion==='exempt'?'免收':price(line.amount,selected.currency)},
        ]}/>
        {selected.assumptions.length>0&&<Alert type="info" message="本次参考假设" description={<ul>{selected.assumptions.map(value=><li key={value}>{value}</li>)}</ul>}/>}
        {selected.warnings.length>0&&<Alert type="warning" message="承运限制与待核事项" description={<ul>{selected.warnings.map((value,index)=><li key={index}>{value}</li>)}</ul>}/>}
        <Table rowKey={(_,index)=>String(index)} pagination={false} size="small" dataSource={selected.tiers} columns={[{title:'原表档位',dataIndex:'label'},{title:'单价',dataIndex:'price',render:value=>value===null?'询价 / 无服务':`${value} ${selected.currency??''}/${selected.basis}`} ]}/>
        {selected.source&&<><Text>{selected.source.name} · {selected.source.sheet} · {selected.source.cells.join('、')}</Text>{selected.source.id&&<a href={`/api/v2/sources/${selected.source.id}/download`}>下载本条报价原表</a>}</>}
        {detail.isLoading&&<Text>正在读取原表备注…</Text>}{detail.error&&<Alert type="error" message={detail.error.message}/>}
        {detail.data?.proposed_data.notes?.map((note,index)=><p key={index} style={{whiteSpace:'pre-wrap'}}>{note}</p>)}
      </Space>}
    </Drawer>
  </div>;
}
