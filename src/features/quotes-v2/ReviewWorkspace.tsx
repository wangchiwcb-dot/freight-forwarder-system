import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import type { PriceDraftRecord, Readiness, ReviewedOffer } from '../../domain/v2/review-contracts';
import { TRANSPORT_MODES, transportLabels, type TransportMode } from '../../domain/v2/contracts';
import { countryNames, quotationApi, todayInChina } from './api';
import { OfferEditor } from './OfferEditor';
import { QuoteUpdates } from './QuoteUpdates';

export function ReviewWorkspace({ initialCountry = 'US', view = 'prices', selectedIds=[], onCompare }: { initialCountry?: string; view?: 'prices'|'rules'; selectedIds?:string[]; onCompare?:(ids:string[],country:string,asOf:string)=>void }) {
  const cache = useQueryClient();
  const [country,setCountry] = useState(initialCountry);
  const [provider,setProvider] = useState<string>();
  const [mode,setMode] = useState<string>();
  const [search,setSearch] = useState('');
  const [page,setPage] = useState(1);
  const [detailId,setDetailId] = useState<string | null>(null);
  const [prepare,setPrepare] = useState<PriceDraftRecord | null>(null);
  const [selectionForm] = Form.useForm();
  const [editor,setEditor] = useState<{ record:ReviewedOffer; sourceDraftId:string|null; persisted:boolean } | null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [updatesOpen,setUpdatesOpen]=useState(false),[asOf,setAsOf]=useState(todayInChina),[history,setHistory]=useState(false);
  const [picked,setPicked]=useState<string[]>(selectedIds);
  useEffect(()=>{setPicked(selectedIds);},[selectedIds.join(',')]);
  useEffect(() => { setCountry(initialCountry); setPage(1); },[initialCountry]);
  const info = useQuery({ queryKey:['v2-readiness'],queryFn:() => quotationApi<Readiness>('/readiness') });
  const params = new URLSearchParams({ page:String(page),pageSize:'15',q:search,asOf,history:String(history) });
  if (country) params.set('country',country); if (provider) params.set('provider',provider); if (mode) params.set('mode',mode);
  const list = useQuery({ queryKey:['v2-search-drafts',params.toString()],queryFn:() => quotationApi<{ items:PriceDraftRecord[]; total:number }>(`/price-drafts?${params}`),enabled:view === 'prices' });
  const detail = useQuery({ queryKey:['v2-draft-detail',detailId],queryFn:() => quotationApi<PriceDraftRecord>(`/price-drafts/${detailId}`),enabled:Boolean(detailId) });
  const rules = useQuery({ queryKey:['v2-review-offers'],queryFn:() => quotationApi<{ items:ReviewedOffer[] }>('/review/offers'),enabled:view === 'rules' });
  const refresh = async () => { await Promise.all(['v2-readiness','v2-search-drafts','v2-review-offers','v2-sources'].map(key => cache.invalidateQueries({ queryKey:[key] }))); };
  const choose = (draft:PriceDraftRecord) => {
    setPrepare(draft); setError('');
    selectionForm.setFieldsValue({ country:!['EU','OTHER'].includes(draft.country_hint) ? draft.country_hint : undefined,
      mode:TRANSPORT_MODES.includes(draft.mode_hint as TransportMode) ? draft.mode_hint : undefined });
  };
  async function create(values:{ mode:TransportMode; country:string }) {
    if (!prepare) return; setBusy(true); setError('');
    try {
      const record = await quotationApi<ReviewedOffer>(`/price-drafts/${prepare.id}/prepare`,values);
      setEditor({ record,sourceDraftId:prepare.id,persisted:false }); setPrepare(null);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const sourceNotes = detail.data?.proposed_data;
  return <>
    {view === 'prices' ? <Card className="v2-review-prices" title="真实报价原表查询" extra={<Space wrap><Button onClick={()=>setUpdatesOpen(true)}>每周报价更新</Button><Button onClick={() => void refresh()}>刷新资料</Button></Space>}>
      <Alert type="info" showIcon message="勾选同一国家的真实报价，加入本次比价" description="按各渠道已知规则计算。未核实的参数和附加费会在结果中单独提示。" />
      <div className="v2-search-filters">
        <Select aria-label="原表目的国家" allowClear placeholder="全部国家" value={country || undefined} onChange={value => { setCountry(value ?? '');setPage(1);setPicked([]); }}
          options={info.data?.countries.map(item => ({ value:item.value,label:`${countryNames[item.value] ?? item.value}（${item.count}）` }))} />
        <Select aria-label="原表代理" allowClear showSearch optionFilterProp="label" placeholder="全部代理" value={provider} onChange={value => { setProvider(value);setPage(1); }}
          options={info.data?.providers.map(item => ({ value:item.value,label:item.value }))} />
        <Select aria-label="原表运输方式" allowClear placeholder="全部主干方式" value={mode} onChange={value => { setMode(value);setPage(1); }}
          options={[...TRANSPORT_MODES.map(value => ({ value,label:transportLabels[value] })),{ value:'unknown',label:'主干方式待核' }]} />
        <Input.Search aria-label="搜索原表报价" placeholder="渠道、仓码、邮编或原表名称" allowClear onSearch={value => { setSearch(value);setPage(1); }} enterButton="查询" />
      </div>
      <Space wrap style={{marginBottom:16}}><Typography.Text>查看报价日期</Typography.Text><Input aria-label="查看报价日期" type="date" value={asOf} onChange={event=>{if(event.target.value){setAsOf(event.target.value);setPage(1);setPicked([]);}}}/><Checkbox checked={history} onChange={event=>{setHistory(event.target.checked);setPage(1);setPicked([]);}}>包含历史和待生效报价</Checkbox></Space>
      {(list.error || info.error) && <Alert type="error" showIcon message={(list.error ?? info.error)?.message} />}
      <Typography.Paragraph type="secondary">找到 {list.data?.total ?? 0} 条原表价格记录</Typography.Paragraph>
      {onCompare&&<Space style={{marginBottom:16}} wrap><Button type="primary" disabled={!picked.length||!country||['EU','OTHER'].includes(country)} onClick={()=>onCompare(picked,country,asOf)}>加入本次比价（{picked.length}）</Button><Button onClick={()=>setPicked([])}>清空选择</Button><Typography.Text type="secondary">最多选择 200 条；查看报价日期会一并带入本次比价。</Typography.Text></Space>}
      <Table<PriceDraftRecord> rowKey="id" loading={list.isFetching} dataSource={list.data?.items ?? []} scroll={{ x:1120 }}
        rowSelection={onCompare?{selectedRowKeys:picked,preserveSelectedRowKeys:true,onChange:keys=>setPicked(keys.map(String).slice(0,200)),getCheckboxProps:row=>({disabled:!country||['EU','OTHER'].includes(country)||!TRANSPORT_MODES.includes(row.mode_hint as TransportMode)})}:undefined}
        pagination={{ current:page,pageSize:15,total:list.data?.total ?? 0,onChange:setPage,showSizeChanger:false }}
        locale={{ emptyText:list.isError ? '资料加载失败，请检查连接后刷新' : '没有符合筛选条件的原表价格，请调整国家、代理或关键词' }}
        columns={[
          { title:'代理 / 渠道',key:'name',width:250,render:(_,row) => <><Typography.Text strong>{row.provider_hint}</Typography.Text><br />{row.channel_hint}<br /><Tag>{transportLabels[row.mode_hint as TransportMode] ?? '主干方式待核'}</Tag>{row.proposed_data.source.hidden && <Tag color="orange">隐藏工作表，待确认</Tag>}</> },
          { title:'目的地 / 交仓点',key:'destination',width:180,render:(_,row) => <>{countryNames[row.country_hint] ?? row.country_hint} · {row.proposed_data.destinationLabel}<br /><Typography.Text type="secondary">{row.proposed_data.origin || '交仓点待核'}</Typography.Text></> },
          { title:'原表成本单价',key:'prices',width:250,render:(_,row) => <>{row.proposed_data.tiers.slice(0,4).map((tier,index) => <div key={index}>{tier.label}：{tier.price === null ? '需询价 / 无服务' : `${tier.price} ${row.proposed_data.currency ?? '币种待核'}/${row.proposed_data.billingBasis}`}</div>)}{row.proposed_data.tiers.length > 4 && <Typography.Text type="secondary">另有 {row.proposed_data.tiers.length-4} 个档位</Typography.Text>}</> },
          { title:'来源 / 复核状态',key:'source',width:250,render:(_,row) => <>{row.source_name}<br /><Typography.Text type="secondary">{row.proposed_data.source.sheet} {row.proposed_data.source.cells.join('、')}</Typography.Text><br/>{row.version_label&&<Tag color="blue">{row.version_label}</Tag>}{row.pricing_state==='pending'&&<Tag>待确认生效</Tag>}{row.version_from&&<div>{row.version_from} 起{row.version_to?`，至 ${row.version_to} 前`:''}</div>}<Tag color="gold">{row.status === 'mapped' ? '已建立规则草稿' : '规则待核'}</Tag></> },
          { title:'操作',key:'actions',width:170,render:(_,row) => <Space direction="vertical"><Button onClick={() => setDetailId(row.id)}>查看价格与备注</Button><Button onClick={() => choose(row)}>建立规则草稿</Button></Space> },
        ]} />
    </Card> : <Card title="渠道规则与报价版本" extra={<Button onClick={() => void refresh()}>刷新版本</Button>}>
      <Alert type="info" showIcon message="从“原表价格查询”建立规则草稿，补齐计费和承运条件后发布" description="每次修改保存为新版本，已发布版本保留。比价优先使用适用日期内已发布的版本。" />
      {rules.error && <Alert type="error" message={rules.error.message} />}
      <Table<ReviewedOffer> rowKey={row => row.offer.id} loading={rules.isFetching} dataSource={rules.data?.items ?? []} scroll={{ x:950 }} pagination={{ pageSize:10 }}
        locale={{ emptyText:'尚未建立真实渠道规则，请先在原表价格查询中选择报价' }} columns={[
          { title:'代理 / 渠道',key:'name',render:(_,row) => <>{row.offer.providerName}<br />{row.offer.name}</> },
          { title:'国家 / 方式',key:'mode',render:(_,row) => `${countryNames[row.offer.country] ?? row.offer.country} · ${transportLabels[row.offer.mode]}` },
          { title:'交仓点 / 单位',key:'origin',render:(_,row) => `${row.offer.origin ?? '待核'} · ${row.offer.currency}/${row.offer.billing.basis}` },
          { title:'版本 / 适用日期',key:'version',render:(_,row)=><>第 {row.offer.revision??1} 版{row.offer.versionLabel&&<div>{row.offer.versionLabel}</div>}<br/>{row.offer.validFrom??'生效日期待核'} 起{row.offer.validTo?`，至 ${row.offer.validTo} 前`:''}</> },
          { title:'状态',key:'status',render:(_,row) => <><Tag color={row.offer.status === 'published' ? 'green' : 'gold'}>{row.offer.status === 'published' ? '已发布' : row.offer.status === 'revoked' ? '已撤销' : '规则草稿'}</Tag>{row.offer.status === 'draft' && <Typography.Text type="secondary">{row.issues.length ? `${row.issues.length} 项发布条件待补齐` : '可发布'}</Typography.Text>}</> },
          { title:'操作',key:'edit',render:(_,row) => <Button onClick={() => setEditor({ record:row,sourceDraftId:null,persisted:true })}>维护规则与价格</Button> },
        ]} />
    </Card>}
    <Drawer title="原表价格与备注" width="min(900px, 100vw)" open={Boolean(detailId)} onClose={() => setDetailId(null)}>
      {detail.error && <Alert type="error" message={detail.error.message} />}
      {detail.isLoading && <Typography.Paragraph>正在读取原表资料…</Typography.Paragraph>}
      {detail.data && sourceNotes && <>
        <Alert type="warning" showIcon message="此处为原表记录，尚未确认完整整票费用" />
        <Typography.Title level={4}>{detail.data.provider_hint} · {sourceNotes.channelName}</Typography.Title>
        <p>{detail.data.source_name} · {sourceNotes.source.sheet} · {sourceNotes.source.cells.join('、')}</p>
        <p>{sourceNotes.destinationLabel}；{sourceNotes.transitText || '时效未明确'}</p>
        <Table rowKey={(_,index) => String(index)} pagination={false} dataSource={sourceNotes.tiers} columns={[
          { title:'档位',dataIndex:'label' },{ title:'原表成本单价',dataIndex:'price',render:value => value == null ? '需询价 / 无服务' : `${value} ${sourceNotes.currency ?? '币种待核'}/${sourceNotes.billingBasis}` },{ title:'单元格',dataIndex:'sourceCell' },
        ]} />
        <Typography.Title level={5}>原表备注</Typography.Title>
        {sourceNotes.notes?.length ? sourceNotes.notes.map((note,index) => <p style={{ whiteSpace:'pre-wrap' }} key={index}>{note}</p>) : <p>此价格区块未关联到备注；请下载原表核对公共附加费及其他工作表。</p>}
        <Space wrap><a href={`/api/v2/sources/${detail.data.source_id}/download`}>下载完整原表</a><Button type="primary" onClick={() => choose(detail.data!)}>建立规则草稿</Button></Space>
      </>}
    </Drawer>
    <Modal title="确认本条报价的主干方式与国家" open={Boolean(prepare)} footer={null} onCancel={() => setPrepare(null)}>
      <p>{prepare?.provider_hint} · {prepare?.channel_hint}</p>
      <Form form={selectionForm} layout="vertical" onFinish={create}>
        <Form.Item name="country" label="国家" rules={[{ required:true,message:'请选择具体国家' }]}><Select options={Object.entries(countryNames).filter(([value]) => !['EU','OTHER'].includes(value)).map(([value,label]) => ({ value,label }))} /></Form.Item>
        <Form.Item name="mode" label="主干运输方式" rules={[{ required:true,message:'请选择主干方式' }]}><Select options={TRANSPORT_MODES.map(value => ({ value,label:transportLabels[value] }))} /></Form.Item>
        {error && <Alert type="error" message={error} />}
        <Button type="primary" htmlType="submit" loading={busy}>进入规则整理</Button>
      </Form>
    </Modal>
    <Drawer title="渠道价格与规则维护" width="min(1100px, 100vw)" open={Boolean(editor)} onClose={() => setEditor(null)} destroyOnHidden>
      {editor && <OfferEditor record={editor.record} sourceDraftId={editor.sourceDraftId} persisted={editor.persisted}
        onSaved={record => { setEditor({ ...editor,record,persisted:true }); void refresh(); }} />}
    </Drawer>
    <Drawer title="每周报价更新" width="min(1200px, 100vw)" open={updatesOpen} onClose={()=>setUpdatesOpen(false)} destroyOnHidden>
      {updatesOpen&&<QuoteUpdates/>}
    </Drawer>
  </>;
}
