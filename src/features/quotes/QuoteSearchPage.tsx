import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Empty, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ApartmentOutlined, ArrowRightOutlined, DatabaseOutlined, DownOutlined, EnvironmentOutlined, FilterOutlined, GlobalOutlined, ReloadOutlined, SearchOutlined, ShopOutlined, SwapOutlined } from '@ant-design/icons';
import { cargoLabels, countryLabels, DEFAULT_CRITERIA, modeLabels, searchQuotes } from '../../domain/search';
import { loadCatalog, loadQuotes } from '../../data/repository';
import type { CountryCode, QuoteResult, SearchCriteria } from '../../domain/types';
import { BillingTag, formatDate, formatMoney, ReliabilityTag, unitLabel } from './display';
import { QuoteDrawer } from './QuoteDrawer';
import { SourceModal } from './SourceModal';

const { Text, Title } = Typography;
const EMPTY_QUOTES: never[] = [];
const countryOptions = [{ value: 'ALL', label: '全部国家 / 地区' }, ...Object.entries(countryLabels).map(([value, label]) => ({ value, label }))];
const modeOptions = [{ value: 'all', label: '全部运输方式' }, ...Object.entries(modeLabels).filter(([value]) => value !== 'unknown').map(([value, label]) => ({ value, label }))];
const cargoOptions = Object.entries(cargoLabels).map(([value, label]) => ({ value, label }));
const sortOptions = [{ value: 'cost', label: '基准运费由低到高' }, { value: 'unit', label: '同单位价格由低到高' }, { value: 'updated', label: '报价日期由新到旧' }, { value: 'reliability', label: '已有验证记录优先' }];

export function QuoteSearchPage() {
  const [form] = Form.useForm<SearchCriteria>();
  const [criteria, setCriteria] = useState<SearchCriteria>({ ...DEFAULT_CRITERIA });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selected, setSelected] = useState<QuoteResult | null>(null);
  const [page, setPage] = useState(1);
  const catalogQuery = useQuery({ queryKey: ['catalog'], queryFn: loadCatalog });
  const catalog = catalogQuery.data;
  const quotesQuery = useQuery({ queryKey: ['quotes', catalog?.version, criteria.country], queryFn: () => loadQuotes(catalog!, criteria.country), enabled: Boolean(catalog) });
  const quotes = quotesQuery.data ?? EMPTY_QUOTES;
  const results = useMemo(() => searchQuotes(quotes, criteria), [quotes, criteria]);
  const isLoading = catalogQuery.isPending || quotesQuery.isFetching;
  const dataError = catalogQuery.error || quotesQuery.error;
  const providers = useMemo(() => [{ value: '', label: '全部代理' }, ...Array.from(new Map(catalog?.files.map((file) => [file.providerId, file.providerName]) ?? []).entries()).map(([value, label]) => ({ value, label }))], [catalog]);
  const computedCount = results.filter((result) => result.eligible && result.estimatedCost !== null).length;
  const pendingCount = results.filter((result) => !result.eligible).length;
  const hasCbm = (catalog?.stats.cbmQuotes ?? 0) > 0;

  function runSearch(values: Partial<SearchCriteria>) { setCriteria((current) => ({ ...current, ...values, destination: values.destination?.trim() ?? current.destination })); setPage(1); }
  function resetSearch() { form.resetFields(); setCriteria({ ...DEFAULT_CRITERIA }); setPage(1); }
  async function refresh() { await catalogQuery.refetch(); await quotesQuery.refetch(); }

  const columns: TableColumnsType<QuoteResult> = [
    { title: '代理 / 渠道', key: 'channel', fixed: 'left', width: 225, render: (_value, result) => <div className="channel-cell"><Space size={6} wrap><Text strong>{result.quote.providerName}</Text>{result.quote.isOwn && <Tag className="own-tag">自有</Tag>}</Space><button className="channel-name" onClick={() => setSelected(result)}>{result.quote.channelName}</button><div className="channel-meta"><span>{modeLabels[result.quote.mode]}</span>{!result.eligible && <Tooltip title={result.warnings[0]}><span className="pending-text">需核对</span></Tooltip>}</div></div> },
    { title: '目的地 / 仓库', key: 'destination', width: 175, render: (_value, { quote }) => <div className="table-lines"><Text className="two-line-text">{quote.destinationLabel || countryLabels[quote.countryCode]}</Text><Text type="secondary" className="table-caption">{quote.warehouseCodes.slice(0, 5).join(' · ') || quote.postalPrefixes.slice(0, 4).join(' · ') || '范围详见原表'}{quote.warehouseCodes.length > 5 ? ` 等 ${quote.warehouseCodes.length} 个` : ''}</Text></div> },
    { title: '交仓地', key: 'origin', width: 125, render: (_value, { quote }) => <Text className="two-line-text">{quote.origin || '未标注'}</Text> },
    { title: '价格阶梯 / 计费', key: 'tier', width: 190, render: (_value, result) => { const tier = result.tier ?? result.quote.tiers.find((item) => item.price !== null); return <div className="table-lines"><BillingTag quote={result.quote} />{tier ? <><Text className="tier-price">{tier.price !== null ? `${formatMoney(tier.price, result.quote.currency)} / ${unitLabel(result.quote)}` : '单询'}</Text><Text type="secondary" className="table-caption">{tier.label}{result.quote.tiers.length > 1 && !result.tier ? ` · 共 ${result.quote.tiers.length} 档` : ''}</Text></> : <Text type="secondary">待确认</Text>}</div>; } },
    { title: <Tooltip title="同币种下按当前输入的已识别规则计算，未包含所有附加费">基准运费 ⓘ</Tooltip>, key: 'cost', width: 165, render: (_value, result) => <div className="table-lines"><span className={`cost-value ${result.eligible && result.estimatedCost !== null ? 'is-estimated' : ''}`}>{result.estimatedCost === null ? '未估算' : formatMoney(result.estimatedCost, result.quote.currency)}</span><Text type="secondary" className="table-caption">{result.estimatedCost !== null ? `${result.chargeableQuantity} ${unitLabel(result.quote)} 计费` : result.estimateLabel}</Text>{!result.eligible && result.estimatedCost !== null && <span className="pending-text">仅作规则参考</span>}</div> },
    { title: '参考时效', key: 'transit', width: 145, render: (_value, { quote }) => <Tooltip title={quote.transitText || '未标注'}><Text className="two-line-text">{quote.transitText || '未标注'}</Text></Tooltip> },
    { title: '报价日期', key: 'date', width: 112, render: (_value, { quote }) => <div className="table-lines"><Text className="date-text">{formatDate(quote.priceDate)}</Text>{quote.dateKind === 'filename' && <Text type="secondary" className="table-caption">依据文件名</Text>}</div> },
    { title: <Tooltip title="依据公司实际走货经验；未建立记录时不推测稳定性">稳定性 ⓘ</Tooltip>, key: 'reliability', width: 108, render: (_value, { quote }) => <ReliabilityTag quote={quote} /> },
    { title: '', key: 'action', fixed: 'right', width: 60, render: (_value, result) => <Button type="text" aria-label={`查看 ${result.quote.channelName} 详情`} icon={<ArrowRightOutlined />} onClick={() => setSelected(result)} /> },
  ];

  const stats = [
    { label: '报价代理', value: catalog?.stats.providers, unit: '家', icon: <ShopOutlined />, className: 'teal' },
    { label: '收录报价', value: catalog?.stats.quotes, unit: '条', icon: <DatabaseOutlined />, className: 'blue' },
    { label: '覆盖国家 / 地区', value: catalog?.stats.countries, unit: '个', icon: <GlobalOutlined />, className: 'purple' },
    { label: '按体积计费', value: catalog?.stats.cbmQuotes, unit: '条', icon: <ApartmentOutlined />, className: 'amber' },
  ];

  return <>
    <div className="page-intro"><div><div className="page-kicker">QUOTE EXPLORER</div><Title level={2}>渠道报价台</Title><p>一处查找代理采购价，为每一票货找到合适的渠道。</p></div><Button icon={<DatabaseOutlined />} onClick={() => setSourcesOpen(true)}>数据源 <span className="button-count">{catalog?.files.length ?? '—'}</span></Button></div>
    <div className="stats-grid">{stats.map((stat) => <Card key={stat.label} variant="borderless"><div className="stat-card"><div><span className="stat-label">{stat.label}</span><div className="stat-value">{stat.value?.toLocaleString('zh-CN') ?? '—'} <span>{stat.unit}</span></div></div><span className={`stat-icon ${stat.className}`}>{stat.icon}</span></div></Card>)}</div>
    {hasCbm && <div className="cbm-banner"><span className="cbm-banner-icon"><SwapOutlined /></span><div><strong>重量与体积，放在同一票货里比较</strong><span>填写实重和体积，可同时查看 KG 与 CBM 渠道的基准运费；中航美线普船支持按体积计费。</span></div><Tag color="cyan">CBM</Tag></div>}
    <Card className="search-card" variant="borderless" title={<Space size={9}><FilterOutlined /><span>筛选与计价条件</span></Space>} extra={<Text type="secondary" className="search-help">重量和体积选填，填写后可估算运费</Text>}>
      <Form<SearchCriteria> layout="vertical" form={form} initialValues={DEFAULT_CRITERIA} onFinish={runSearch} requiredMark={false}>
        <div className="search-grid">
          <Form.Item label="国家 / 地区" name="country"><Select aria-label="国家 / 地区" showSearch optionFilterProp="label" options={countryOptions} /></Form.Item>
          <Form.Item label="运输方式" name="mode"><Select aria-label="运输方式" options={modeOptions} /></Form.Item>
          <Form.Item label="派送目的地" name="delivery"><Select aria-label="派送目的地" options={[{ value: 'all', label: '全部目的地类型' }, { value: 'amazon', label: '亚马逊仓库' }, { value: 'commercial', label: '商业地址 / 其他平台仓' }, { value: 'residential', label: '私人 / 住宅地址' }]} placeholder="全部目的地类型" /></Form.Item>
          <Form.Item label="仓库代码 / 邮编" name="destination"><Input aria-label="仓库代码 / 邮编" allowClear placeholder="如 ONT8、LAX9、90001" prefix={<EnvironmentOutlined />} /></Form.Item>
          <Form.Item label="货品属性" name="cargo"><Select aria-label="货品属性" options={cargoOptions} /></Form.Item>
          <Form.Item label="货物实重" name="actualKg"><InputNumber aria-label="货物实重" min={0.01} precision={2} className="full-width" placeholder="输入实重" suffix="kg" /></Form.Item>
          <Form.Item label="货物体积" name="volumeCbm"><InputNumber aria-label="货物体积" min={0.001} precision={3} className="full-width" placeholder="输入总体积" suffix="CBM" /></Form.Item>
          <Form.Item label="货物件数" name="pieces"><InputNumber aria-label="货物件数" min={1} precision={0} className="full-width" placeholder="输入件数" suffix="件" /></Form.Item>
        </div>
        {advancedOpen && <div className="advanced-row">
          <Form.Item label="代理" name="providerId"><Select aria-label="代理" showSearch optionFilterProp="label" options={providers} /></Form.Item>
          <Form.Item label="交仓地区" name="origin"><Input aria-label="交仓地区" allowClear placeholder="如 深圳、青岛、上海" /></Form.Item>
          <Form.Item label="重货 / 抛货" name="cargoShape" tooltip="按渠道计费规则判断；填写实重和体积后使用。"><Select aria-label="重货 / 抛货" options={[{ value: 'all', label: '不限定' }, { value: 'dense', label: '重货' }, { value: 'bulky', label: '抛货' }]} /></Form.Item>
          <Form.Item label="查询日期" name="asOf" rules={[{ required: true, message: '请选择查询日期' }]}><Input aria-label="查询日期" type="date" /></Form.Item>
          <Form.Item label="保留待核候选" name="includePending" valuePropName="checked"><Switch aria-label="保留待核候选" /></Form.Item>
        </div>}
        <div className="search-actions"><Space size={10}><Button type="primary" htmlType="submit" icon={<SearchOutlined />}>搜索报价</Button><Button onClick={resetSearch}>重置</Button><Button type="text" className="advanced-toggle" icon={<DownOutlined rotate={advancedOpen ? 180 : 0} />} onClick={() => setAdvancedOpen((value) => !value)}>高级筛选</Button></Space><Space size={9}><Text type="secondary">仅看自有采购</Text><Switch aria-label="仅看自有采购" checked={criteria.onlyOwn} onChange={(onlyOwn) => runSearch({ onlyOwn })} size="small" /></Space></div>
      </Form>
    </Card>
    {dataError && <Alert style={{ marginBottom: 18 }} type="error" showIcon message="报价数据读取失败" description={dataError.message} action={<Button icon={<ReloadOutlined />} onClick={() => void refresh()}>重试</Button>} />}
    <Card className="results-card" variant="borderless" title={<div className="result-title"><span>渠道列表</span><Badge count={results.length} overflowCount={999999} showZero color="#e9f3f1" style={{ color: '#0b887c', boxShadow: 'none' }} /></div>} extra={<Space size={10}><Select aria-label="结果排序" value={criteria.sort} options={sortOptions} onChange={(sort) => runSearch({ sort })} className="sort-select" variant="borderless" /><Tooltip title="重新读取数据"><Button type="text" aria-label="刷新报价数据" icon={<ReloadOutlined spin={isLoading} />} onClick={() => void refresh()} /></Tooltip></Space>}>
      <div className="result-summary"><div><span>{criteria.country === 'ALL' ? '全部国家' : countryLabels[criteria.country as CountryCode]}</span><span>·</span><span>{criteria.mode === 'all' ? '全部运输方式' : modeLabels[criteria.mode]}</span><span>·</span><span>{cargoLabels[criteria.cargo]}</span><span className="summary-extra"> · {computedCount} 条可估算{pendingCount > 0 ? `，${pendingCount} 条需核对` : ''}</span></div><Text type="secondary">查询日期 {criteria.asOf}</Text></div>
      <Table<QuoteResult> rowKey={(row) => row.quote.id} loading={isLoading} columns={columns} dataSource={results} scroll={{ x: 1180 }} pagination={{ current: page, pageSize: 15, showSizeChanger: false, onChange: setPage, showTotal: (total) => `共 ${total.toLocaleString('zh-CN')} 条报价` }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={dataError ? '数据读取失败，请重试' : '暂无匹配渠道，试试调整国家、货品或目的地'} /> }} />
    </Card>
    <div className="page-footer"><span>深圳中航环球国际货运代理有限公司</span><span>报价数据版本 {catalog?.version || '—'} · 仅供内部采购参考</span></div>
    <QuoteDrawer result={selected} onClose={() => setSelected(null)} /><SourceModal catalog={catalog} open={sourcesOpen} onClose={() => setSourcesOpen(false)} />
  </>;
}
