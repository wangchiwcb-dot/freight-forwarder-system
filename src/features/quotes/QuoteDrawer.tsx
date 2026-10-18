import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Collapse, Descriptions, Divider, Drawer, List, Space, Spin, Table, Tag, Typography } from 'antd';
import { fetchHistory, fetchQuote } from '../../data/api';
import { cargoLabels, countryLabels, modeLabels } from '../../domain/search';
import type { HistoryEntry, QuoteResult, RateTier } from '../../domain/types';
import { BillingTag, formatDate, formatMoney, ReliabilityTag, unitLabel } from './display';

const { Title, Text } = Typography;
const taxLabel = (mode: string) => ({ included:'包税',excluded:'不包税',partial:'部分包含',conditional:'按条件确定',unknown:'待确认' }[mode] ?? mode);
const settlementLabel = (mode: string) => ({ unknown:'未单独说明',deferred:'VAT 递延 / PVA',vat_deferred:'VAT 递延 / PVA',customer_tax:'客户自税',deferred_or_customer_tax:'VAT 递延 / 客户自税可选',alternatives:'多种税费选项',tier_specific:'按档位区分' }[mode] ?? mode);
const acceptanceLabel = (value:string) => ({allowed:'明确可接',forbidden:'明确不接',conditional:'有条件 / 需单询',unknown:'未确认'}[value] ?? value);
export function QuoteDrawer({ result, onClose }: { result: QuoteResult | null; onClose: () => void }) {
  const [historyPage,setHistoryPage]=useState(1);
  const [historyOpen,setHistoryOpen]=useState(false);
  useEffect(()=>{setHistoryPage(1);setHistoryOpen(false);},[result?.quote.id]);
  const detail=useQuery({queryKey:['quote',result?.quote.id],queryFn:({signal})=>fetchQuote(result!.quote.id,signal),enabled:!!result});
  const history=useQuery({queryKey:['history',result?.quote.id,historyPage],queryFn:({signal})=>fetchHistory(result!.quote.id,historyPage,signal),enabled:!!result && historyOpen});
  const quote = detail.data;
  return <Drawer open={Boolean(result)} onClose={onClose} width="min(660px, 100vw)" title="渠道报价详情" destroyOnHidden>
    {detail.isPending && result && <Spin tip="正在读取报价详情"><div style={{height:120}} /></Spin>}
    {detail.error && <Alert type="error" message="详情读取失败" description={detail.error.message} action={<Button onClick={()=>void detail.refetch()}>重试</Button>} />}
    {quote && result && <Space direction="vertical" size={22} className="full-width">
      <div><Space wrap><Text type="secondary">{quote.providerName}</Text>{quote.isOwn && <Tag color="cyan">自有采购</Tag>}<BillingTag quote={quote} /></Space><Title level={4} style={{ margin: '8px 0 0' }}>{quote.channelName}</Title></div>
      <div className="drawer-estimate"><Text type="secondary">本票基准运费</Text><div className="drawer-money">{formatMoney(result.estimatedCost, quote.currency)}</div><Text>{result.estimatedCost === null ? result.estimateLabel : `${result.chargeableQuantity ?? '—'} ${unitLabel(quote)} · ${result.estimateLabel}`}</Text><div className="estimate-footnote">仅按已识别规则估算，附加费与最终承运条件需确认。</div></div>
      {!result.eligible && <Alert type="warning" showIcon message="当前条件下需核对" description={result.warnings[0] || '适用范围或计费规则尚需确认。'} />}
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="国家 / 运输方式">{countryLabels[quote.countryCode]} · {modeLabels[quote.mode]}</Descriptions.Item>
        <Descriptions.Item label="目的地">{quote.destinationLabel || '未标注'}{quote.warehouseCodes.length ? ` · ${quote.warehouseCodes.join(' / ')}` : ''}</Descriptions.Item>
        <Descriptions.Item label="交货仓">{quote.origin || '未标注'}</Descriptions.Item>
        <Descriptions.Item label="承运货品">{quote.cargoTypes.map((type) => cargoLabels[type]).join('、') || '未确认'} {quote.cargoCertainty !== 'explicit' && <Tag>需核对</Tag>}</Descriptions.Item>
        <Descriptions.Item label="时效口径">{quote.transitText || '原表未标注'}</Descriptions.Item>
        <Descriptions.Item label="报价日期">{formatDate(quote.priceDate)}{quote.dateKind === 'filename' && <Text type="secondary">（文件名）</Text>}</Descriptions.Item>
        <Descriptions.Item label="生效时间">{quote.effectiveAt || '未单独标注'}</Descriptions.Item>
        {quote.validTo && <Descriptions.Item label="失效时间">{quote.validTo}</Descriptions.Item>}
        {quote.tax && <Descriptions.Item label="税费口径"><Space wrap><Tag color="blue">{taxLabel(quote.tax.mode)}</Tag><Text>{settlementLabel(quote.tax.settlement)}</Text><Tag>{quote.tax.evidenceKind==='business_default'?'业务默认口径':'原表依据'}</Tag></Space><p className="source-note">{quote.tax.evidence}</p></Descriptions.Item>}
      </Descriptions>
      {quote.cargoAcceptance && <section><Title level={5}>货品承运依据</Title><List size="small" dataSource={quote.cargoAcceptance} renderItem={item=><List.Item><div><Space><Text strong>{cargoLabels[item.type]}</Text><Tag color={item.acceptance==='allowed'?'success':item.acceptance==='forbidden'?'error':'gold'}>{acceptanceLabel(item.acceptance)}</Tag></Space><p className="source-note">{item.evidence}{item.conditions.length ? `；${item.conditions.join('；')}` : ''}</p></div></List.Item>} /></section>}
      <section><Title level={5}>计费阶梯</Title><Table<RateTier> size="small" pagination={false} rowKey={(tier, index) => `${tier.sourceCell}-${index}`} dataSource={quote.tiers} scroll={{ x: 500 }} columns={[
        { title: '原表阶梯', dataIndex: 'label' },
        { title: `价格（${quote.currency || '币种待核'}/${unitLabel(quote)}）`, dataIndex: 'price', render: (value: number | null, tier) => value === null ? <Tag>{tier.status === 'inquiry' ? '单询' : '无价格'}</Tag> : <Text strong>{value}{tier.fixedFee != null ? ` + ${tier.fixedFee} 固定费` : ''}</Text> },
        { title: '档位税费', key: 'tax', render: (_value, tier) => tier.tax ? <div><Tag>{taxLabel(tier.tax.mode)}</Tag><Text type="secondary">{settlementLabel(tier.tax.settlement)}</Text></div> : '未标注' },
        { title: '来源', dataIndex: 'sourceCell' },
      ]} /></section>
      <section><Title level={5}>计算规则</Title><Descriptions size="small" column={1}><Descriptions.Item label="整票最低重量">{quote.minShipmentKg != null ? `${quote.minShipmentKg} kg` : '未单独提取'}</Descriptions.Item><Descriptions.Item label="单件最低重量">{quote.minPieceKg != null ? `${quote.minPieceKg} kg` : '未单独提取'}</Descriptions.Item><Descriptions.Item label="最低体积">{quote.minCbm != null ? `${quote.minCbm} CBM` : '未单独提取'}</Descriptions.Item>{quote.volumetricDivisor && <Descriptions.Item label="材积除数">{quote.volumetricDivisor}（尺寸单位 cm）</Descriptions.Item>}{(quote.densityConversionKgPerCbm ?? quote.volumeEquivalentKgPerCbm) != null && <Descriptions.Item label="超重折算体积">取实测体积与实重 ÷ {quote.densityConversionKgPerCbm ?? quote.volumeEquivalentKgPerCbm} 的较大值</Descriptions.Item>}{quote.maxKgPerCbm != null && <Descriptions.Item label="密度限制">{quote.maxKgPerCbm} kg/CBM</Descriptions.Item>}</Descriptions></section>
      {result.warnings.length > 0 && <section><Title level={5}>适用提示</Title><List size="small" dataSource={[...new Set(result.warnings)]} renderItem={(item) => <List.Item><Text className="source-note">{item}</Text></List.Item>} /></section>}
      <section><Title level={5}>原表规则与附加费</Title><Text type="secondary">最低计费、赔付、货品限制均保留为渠道规则。</Text><div className="source-notes">{quote.notes.length ? quote.notes.map((note, index) => <p key={index}>{note}</p>) : <Text type="secondary">无已提取的补充说明，请核对原报价。</Text>}</div></section>
      {!!quote.charges?.length && <section><Title level={5}>已保存的费用条件</Title><Alert type="info" showIcon message="费用有适用条件，未全部计入本票基准运费" /><List size="small" dataSource={quote.charges} renderItem={fee=><List.Item><div><Text strong>{fee.label} · {fee.amount ?? '待核'} {fee.currency ?? ''}</Text><p>计费单位：{{shipment:'每票',piece:'每件',kg:'每公斤',cbm:'每方'}[fee.basis] ?? '待确认'} · {fee.reviewStatus==='verified'?'金额与单位已核对':'需核对'}</p>{fee.conditions.delivery_zone != null && <Tag color="gold">仅适用分区：{String(fee.conditions.delivery_zone)}</Tag>}<p className="source-note">{fee.evidence}</p></div></List.Item>} /></section>}
      <Collapse onChange={keys=>setHistoryOpen(keys.includes('history'))} activeKey={historyOpen?['history']:[]} items={[{key:'history',label:'同条件历史报价',children:<>
        <Text type="secondary">{history.data?.identityNote ?? '按暂定业务条件关联，保留原始报价日期与各档价格。'}</Text>
        {history.error && <Alert type="error" message={history.error.message} action={<Button onClick={()=>void history.refetch()}>重试</Button>} />}
        <Table<HistoryEntry> style={{marginTop:12}} size="small" loading={history.isFetching} rowKey="id" dataSource={history.data?.items ?? []}
          pagination={{current:historyPage,pageSize:5,total:history.data?.total ?? 0,onChange:setHistoryPage,showSizeChanger:false}}
          columns={[{title:'报价日期',dataIndex:'quotedOn',render:(value:string|null,row)=><div>{formatDate(value)}{row.dateEvidence==='filename'&&<div><Tag>文件名日期</Tag></div>}</div>},
            {title:'来源资料',key:'source',render:(_value,row)=><div>{row.fileName}<div><Text type="secondary">{row.snapshots.join(' / ')}</Text></div></div>},
            {title:'税费',dataIndex:'taxMode',render:taxLabel}]}
          expandable={{expandedRowRender:row=><List size="small" dataSource={row.tiers} renderItem={tier=><List.Item>{tier.label}：{tier.price ?? '单询'} {quote.currency ?? ''} / {unitLabel(quote)}{tier.fixedFee!=null?` + ${tier.fixedFee} 固定费（核对适用范围）`:''} · {tier.sourceCell}</List.Item>} />}} />
      </>}]} />
      <Card size="small" title="来源与使用评价"><Descriptions column={1} size="small"><Descriptions.Item label="文件">{quote.source.fileName}</Descriptions.Item><Descriptions.Item label="工作表">{quote.source.sheet}{quote.source.hidden && '（隐藏页）'}</Descriptions.Item><Descriptions.Item label="单元格">{quote.source.cells.join('、')}</Descriptions.Item><Descriptions.Item label="稳定性"><ReliabilityTag quote={quote} /></Descriptions.Item><Descriptions.Item label="评价依据">{quote.reliability.note || '尚无公司实际走货评价，代理宣称时效不等同于稳定性。'}</Descriptions.Item></Descriptions>{quote.reviewReasons.length > 0 && <><Divider style={{ margin: '12px 0' }} /><Text type="secondary">待核项：{quote.reviewReasons.join('；')}</Text></>}</Card>
    </Space>}
  </Drawer>;
}
