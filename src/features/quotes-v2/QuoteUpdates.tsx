import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Divider, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import type { QuoteSource, QuoteUpdateInput, QuoteUpdatePreview, QuoteUpdateRow } from '../../domain/v2/update-contracts';
import { quotationApi, todayInChina } from './api';

export function QuoteUpdates() {
  const cache=useQueryClient(),[form]=Form.useForm<QuoteUpdateInput>();
  const [preview,setPreview]=useState<QuoteUpdatePreview|null>(null);
  const [input,setInput]=useState<QuoteUpdateInput|null>(null);
  const [mappings,setMappings]=useState<QuoteUpdateInput['mappings']>([]);
  const [dirty,setDirty]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [matching,setMatching]=useState<QuoteUpdateRow|null>(null),[matchSearch,setMatchSearch]=useState(''),[matchError,setMatchError]=useState(''),[matchBusy,setMatchBusy]=useState(false);
  const [candidates,setCandidates]=useState<{items:{id:string;channel:string;destination:string;prices:string}[];total:number;page:number}>({items:[],total:0,page:1});
  const sources=useQuery({queryKey:['v2-sources'],queryFn:()=>quotationApi<{items:QuoteSource[]}>('/sources')});
  const history=useQuery({queryKey:['v2-quote-updates'],queryFn:()=>quotationApi<{items:{id:string;label:string;source_name:string;effective_from:string;summary:QuoteUpdatePreview['summary']}[]}>('/quote-updates')});
  async function inspect(page=1) {
    try {
      const values=await form.validateFields();setBusy(true);setError('');setSuccess('');
      const update={...values,previousSourceId:values.previousSourceId??null,mappings};
      const result=await quotationApi<QuoteUpdatePreview>('/quote-updates/preview',{update,page});
      setInput(update);setPreview(result);setDirty(false);
    } catch(error) { if(error instanceof Error)setError(error.message); }
    finally {setBusy(false);}
  }
  async function activate() {
    if(!input||!preview||dirty)return;
    setBusy(true);setError('');
    try {
      const result=await quotationApi<{summary:QuoteUpdatePreview['summary'];inherited?:number}>('/quote-updates/activate',{update:input,token:preview.token});
      setSuccess(`已确认“${input.label}”，从 ${input.effectiveFrom} 起使用。本次关联 ${result.summary.matched} 条，新增 ${result.summary.added} 条，未匹配的 ${result.summary.retained} 条旧价继续沿用。${result.inherited??0} 条计费规则已带入新草稿，仍需复核。`);
      setPreview(null);setInput(null);setMappings([]);setDirty(true);form.resetFields();
      await Promise.all(['v2-sources','v2-quote-updates','v2-readiness','v2-search-drafts','v2-review-offers'].map(key=>cache.invalidateQueries({queryKey:[key]})));
    }catch(error){setError((error as Error).message);setDirty(true);}
    finally{setBusy(false);}
  }
  async function findCandidates(row:QuoteUpdateRow,q='',page=1) {
    setMatching(row);setMatchSearch(q);setMatchBusy(true);setMatchError('');
    try {
      const values=await form.validateFields();
      setCandidates(await quotationApi('/quote-updates/candidates',{update:{...values,previousSourceId:values.previousSourceId??null,mappings},draftId:row.id,q,page}));
    }catch(error){if(error instanceof Error)setMatchError(error.message);}
    finally{setMatchBusy(false);}
  }
  const labels={new:'新增渠道',changed:'有变化',unchanged:'价格条款未变',ambiguous:'需要确认匹配'};
  return <Space direction="vertical" size="middle" style={{width:'100%'}}>
    <Alert type="info" showIcon message="各代理分别更新，没有新表的代理继续沿用旧价" description="新原表完成解析导入后会出现在这里。预览并确认生效日期后，匹配的渠道按日期切换；未匹配的旧渠道继续保留。确认原表生效不会自动发布未经复核的计费规则。" />
    {sources.error&&<Alert type="error" message={sources.error.message}/>}
    {error&&<Alert type="error" showIcon message={error}/>}
    {success&&<Alert type="success" showIcon message={success}/>}
    <Form form={form} layout="vertical" initialValues={{effectiveFrom:todayInChina(),previousSourceId:null}} onFinish={()=>void inspect()} onValuesChange={changed=>{
      setDirty(true);setSuccess('');if('sourceId' in changed||'previousSourceId' in changed){setMappings([]);setPreview(null);}
    }} disabled={busy}>
      <Form.Item name="sourceId" label="本期新报价表" rules={[{required:true,message:'请选择已导入的新原表'}]}>
        <Select showSearch optionFilterProp="label" placeholder="选择待生效的原表" options={sources.data?.items.filter(s=>s.pricing_state==='pending'&&s.price_drafts>0).map(s=>({value:s.id,label:`${s.name}（${s.price_drafts} 条）`}))}/>
      </Form.Item>
      <Form.Item name="previousSourceId" label="对应的上一期报价表">
        <Select allowClear showSearch optionFilterProp="label" placeholder="首次接入该报价表时留空" options={sources.data?.items.filter(s=>s.pricing_state!=='pending'&&s.price_drafts>0).map(s=>({value:s.id,label:`${s.name}${s.version_label?` · ${s.version_label}`:''}`}))}/>
      </Form.Item>
      <div className="v2-form-grid">
        <Form.Item name="label" label="本期名称" rules={[{required:true,message:'填写本期名称'}]}><Input maxLength={100} placeholder="例如：中航美线 10月28日版"/></Form.Item>
        <Form.Item name="effectiveFrom" label="本期生效日期" rules={[{required:true}]}><Input type="date"/></Form.Item>
      </div>
      <Button type="primary" htmlType="submit" loading={busy}>预览本期变化</Button>
    </Form>
    {preview&&<>
      <Space wrap><Tag>本期 {preview.summary.total} 条</Tag><Tag color="blue">匹配 {preview.summary.matched}</Tag><Tag color="orange">变化 {preview.summary.changed}</Tag><Tag color="green">新增 {preview.summary.added}</Tag><Tag>沿用旧价 {preview.summary.retained}</Tag><Tag color={preview.summary.ambiguous?'red':'default'}>待匹配 {preview.summary.ambiguous}</Tag></Space>
      {preview.summary.retained>0&&<Alert type="warning" showIcon message={`${preview.summary.retained} 条旧渠道没有在新表中匹配到，将继续沿用旧价`} description={`请核对是否为渠道改名或范围调整，可用“关联旧渠道”明确对应关系，无需修改原始报价表。示例：${preview.retainedExamples.slice(0,5).join('；')}`}/>}
      <Table<QuoteUpdateRow> size="small" rowKey="id" dataSource={preview.items} scroll={{x:850}}
        pagination={{current:preview.page,pageSize:preview.pageSize,total:preview.summary.total,showSizeChanger:false,onChange:page=>void inspect(page)}} columns={[
          {title:'渠道 / 目的地',key:'name',render:(_,row)=><>{row.channel}<br/>{row.country} · {row.destination}</>},
          {title:'变化',key:'kind',render:(_,row)=><><Tag color={row.kind==='ambiguous'?'red':'blue'}>{labels[row.kind]}</Tag><br/>{row.changes.join('、')}</>},
          {title:'上一期 → 本期',key:'prices',width:270,render:(_,row)=><><Typography.Text type="secondary">{row.previousPrices||'无匹配旧价'}</Typography.Text><br/>{row.prices}</>},
          {title:'匹配确认',key:'match',width:220,render:(_,row)=><Space direction="vertical" style={{width:'100%'}}>{row.candidates.length>0?<Select style={{width:'100%'}} aria-label={`匹配 ${row.channel} ${row.destination}`} placeholder="请选择对应旧渠道或新增"
            value={mappings.find(m=>m.draftId===row.id)?.previousDraftId??(mappings.some(m=>m.draftId===row.id)?'__new__':row.previousDraftId??undefined)}
            options={[{value:'__new__',label:'确认作为新增渠道'},...row.candidates.map(c=>({value:c.id,label:c.label}))]}
            onChange={value=>{setMappings(current=>[...current.filter(m=>m.draftId!==row.id),{draftId:row.id,previousDraftId:value==='__new__'?null:value}]);setDirty(true);}}/>:row.previousDraftId?'已关联旧渠道':'新增渠道'}{input?.previousSourceId&&<Button onClick={()=>void findCandidates(row)}>关联旧渠道</Button>}</Space>},
        ]}/>
      {dirty&&<Alert type="info" message="匹配或填写内容已变化，请重新预览后确认生效"/>}
      <Button type="primary" loading={busy} disabled={dirty||preview.summary.ambiguous>0} onClick={()=>void activate()}>确认本期生效</Button>
    </>}
    <Divider>已确认的报价更新</Divider>
    {history.error&&<Alert type="error" message={history.error.message}/>}
    <Table size="small" rowKey="id" dataSource={history.data?.items??[]} pagination={{pageSize:10}} scroll={{x:600}} columns={[
      {title:'报价期',dataIndex:'label'}, {title:'原表',dataIndex:'source_name'}, {title:'生效日期',dataIndex:'effective_from'},
      {title:'更新情况',key:'summary',render:(_,row)=>`匹配 ${row.summary.matched} / 新增 ${row.summary.added} / 沿用 ${row.summary.retained}`},
    ]}/>
    <Modal title="关联上一期渠道" open={Boolean(matching)} footer={null} onCancel={()=>{if(!matchBusy)setMatching(null);}} width={800}>
      <Typography.Paragraph>本期：{matching?.channel} · {matching?.destination}。只列出相同代理、国家、运输方式、币种及计费单位的旧报价。</Typography.Paragraph>
      <Input.Search aria-label="搜索上一期渠道" value={matchSearch} onChange={event=>setMatchSearch(event.target.value)} onSearch={q=>{if(matching)void findCandidates(matching,q);}} enterButton="查找"/>
      {matchError&&<Alert type="error" message={matchError}/>}
      <Table rowKey="id" size="small" loading={matchBusy} dataSource={candidates.items} scroll={{x:600}}
        pagination={{current:candidates.page,pageSize:20,total:candidates.total,showSizeChanger:false,onChange:page=>{if(matching)void findCandidates(matching,matchSearch,page);}}} columns={[
          {title:'上一期渠道',dataIndex:'channel'},{title:'目的地',dataIndex:'destination'},{title:'单价档位',dataIndex:'prices'},
          {title:'操作',key:'select',render:(_,row)=><Button disabled={matchBusy} onClick={()=>{
            if(matching)setMappings(current=>[...current.filter(m=>m.draftId!==matching.id),{draftId:matching.id,previousDraftId:row.id}]);setDirty(true);setMatching(null);
          }}>关联此渠道</Button>},
        ]}/>
    </Modal>
  </Space>;
}
