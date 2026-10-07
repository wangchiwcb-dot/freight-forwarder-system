import { Alert, Card, Descriptions, Divider, Drawer, List, Space, Table, Tag, Typography } from 'antd';
import { cargoLabels, countryLabels, modeLabels } from '../../domain/search';
import type { QuoteResult, RateTier } from '../../domain/types';
import { BillingTag, formatDate, formatMoney, ReliabilityTag, unitLabel } from './display';

const { Title, Text } = Typography;
export function QuoteDrawer({ result, onClose }: { result: QuoteResult | null; onClose: () => void }) {
  const quote = result?.quote;
  return <Drawer open={Boolean(result)} onClose={onClose} width="min(660px, 100vw)" title="渠道报价详情" destroyOnHidden>
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
      </Descriptions>
      <section><Title level={5}>计费阶梯</Title><Table<RateTier> size="small" pagination={false} rowKey={(tier, index) => `${tier.sourceCell}-${index}`} dataSource={quote.tiers} scroll={{ x: 410 }} columns={[{ title: '原表阶梯', dataIndex: 'label' }, { title: `价格（${quote.currency || '币种待核'}/${unitLabel(quote)}）`, dataIndex: 'price', render: (value: number | null, tier) => value === null ? <Tag>{tier.status === 'inquiry' ? '单询' : '无价格'}</Tag> : <Text strong>{value}{tier.fixedFee != null ? ` + ${tier.fixedFee} 固定费` : ''}</Text> }, { title: '来源', dataIndex: 'sourceCell' }]} /></section>
      <section><Title level={5}>计算规则</Title><Descriptions size="small" column={1}><Descriptions.Item label="整票最低重量">{quote.minShipmentKg != null ? `${quote.minShipmentKg} kg` : '未单独提取'}</Descriptions.Item><Descriptions.Item label="单件最低重量">{quote.minPieceKg != null ? `${quote.minPieceKg} kg` : '未单独提取'}</Descriptions.Item><Descriptions.Item label="最低体积">{quote.minCbm != null ? `${quote.minCbm} CBM` : '未单独提取'}</Descriptions.Item>{quote.volumetricDivisor && <Descriptions.Item label="材积除数">{quote.volumetricDivisor}（尺寸单位 cm）</Descriptions.Item>}{(quote.densityConversionKgPerCbm ?? quote.volumeEquivalentKgPerCbm) != null && <Descriptions.Item label="超重折算体积">取实测体积与实重 ÷ {quote.densityConversionKgPerCbm ?? quote.volumeEquivalentKgPerCbm} 的较大值</Descriptions.Item>}{quote.maxKgPerCbm != null && <Descriptions.Item label="密度限制">{quote.maxKgPerCbm} kg/CBM</Descriptions.Item>}</Descriptions></section>
      {result.warnings.length > 0 && <section><Title level={5}>适用提示</Title><List size="small" dataSource={[...new Set(result.warnings)]} renderItem={(item) => <List.Item><Text className="source-note">{item}</Text></List.Item>} /></section>}
      <section><Title level={5}>原表规则与附加费</Title><Text type="secondary">最低计费、赔付、货品限制均保留为渠道规则。</Text><div className="source-notes">{quote.notes.length ? quote.notes.map((note, index) => <p key={index}>{note}</p>) : <Text type="secondary">无已提取的补充说明，请核对原报价。</Text>}</div></section>
      <Card size="small" title="来源与使用评价"><Descriptions column={1} size="small"><Descriptions.Item label="文件">{quote.source.fileName}</Descriptions.Item><Descriptions.Item label="工作表">{quote.source.sheet}{quote.source.hidden && '（隐藏页）'}</Descriptions.Item><Descriptions.Item label="单元格">{quote.source.cells.join('、')}</Descriptions.Item><Descriptions.Item label="稳定性"><ReliabilityTag quote={quote} /></Descriptions.Item><Descriptions.Item label="评价依据">{quote.reliability.note || '尚无公司实际走货评价，代理宣称时效不等同于稳定性。'}</Descriptions.Item></Descriptions>{quote.reviewReasons.length > 0 && <><Divider style={{ margin: '12px 0' }} /><Text type="secondary">待核项：{quote.reviewReasons.join('；')}</Text></>}</Card>
    </Space>}
  </Drawer>;
}
