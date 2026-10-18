import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { Alert, Button, Card, Collapse, Descriptions, Drawer, Empty, InputNumber, Modal, Segmented, Select, Skeleton, Space, Switch, Table, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import { ArrowRightOutlined, BarChartOutlined, ClockCircleOutlined, DatabaseOutlined, DownloadOutlined, InfoCircleOutlined, LeftOutlined, PrinterOutlined, RightOutlined } from '@ant-design/icons';
import { flagLabels, loadTransit, nodeLabels, type TransitDataset, type TransitRecord } from './data';
import { channelComparison, coverage, filterRecords, formatDays, heatmapData, periodDomain, periodEnd, periodKey, periodLabel as formatPeriod, periodWindow, regionalOverview, stageSummary, summarize, thresholdShare, totalDays, trend, type Granularity, type TransitFilters } from './metrics';
import { ComparisonChart, StageChart, TrendChart, WarehouseHeatmap } from './TransitCharts';
import { colors } from '../../theme/tokens';
import { defaultTransitFilters, filterKeys, readTransitFilters } from './filters';
import { TransitControls } from './TransitControls';
import { ChannelOverview, WarehouseComparison } from './TransitOverview';
import { warehouseLocation } from './warehouseLocation';
import './transit.css';

const { Text, Title } = Typography;
const num = (n: number) => n.toLocaleString('zh-CN');
const displayDate = (date: string | null) => date ? date.replace('T00:00:00', '').replace('T', ' ') : '未回填';
const qualityStatus = (r: TransitRecord) => r.status === 'invalid' ? <Tag color="error">日期异常</Tag> : r.status === 'unknown' ? <Tag color="warning">到仓未回填</Tag> : <Tag color="success">已到仓</Tag>;

export default function TransitPage() {
  const query = useQuery({ queryKey: ['transit-dataset'], queryFn: ({ signal }) => loadTransit(signal), staleTime: 5 * 60_000, retry: 1 });
  if (query.isPending) return <div aria-label="正在加载渠道时效"><Skeleton active paragraph={{ rows: 10 }} /></div>;
  if (query.isError) return <Alert type="error" showIcon message="时效数据暂时无法加载" description={query.error.message} action={<Button onClick={() => query.refetch()}>重新加载</Button>} />;
  return <TransitDashboard dataset={query.data} />;
}

function TransitDashboard({ dataset }: { dataset: TransitDataset }) {
  const { manifest, records, warehouses, rules } = dataset;
  const [params, setParams] = useSearchParams();
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [trendOpen, setTrendOpen] = useState(false);
  const [openPanels, setOpenPanels] = useState<string[]>([]);
  const [printing, setPrinting] = useState(false);
  const [windowOffset, setWindowOffset] = useState(0);
  const [threshold, setThreshold] = useState(20);
  const [customerMode, setCustomerMode] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selected, setSelected] = useState<TransitRecord | null>(null);
  const [period, setPeriod] = useState('');
  const [detailStatus, setDetailStatus] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [messageApi, messageContext] = message.useMessage();
  const reportRef = useRef<HTMLDivElement>(null);
  const filters = useMemo(() => readTransitFilters(params, manifest.dataThrough), [params, manifest.dataThrough]);
  const isRoute = !!filters.warehouse && !!filters.channel;
  const latestFilters = useRef(filters);
  useEffect(() => { latestFilters.current = filters; }, [filters]);
  const updateFilters = useCallback((patch: Partial<TransitFilters>) => {
    const next = { ...latestFilters.current, ...patch };
    latestFilters.current = next;
    setParams(Object.fromEntries(filterKeys.map(k => [k, next[k]])), { replace: true });
    setPeriod(''); setDetailStatus('all'); setWindowOffset(0);
  }, [setParams]);
  const selectedRows = useMemo(() => filterRecords(records, filters), [records, filters]);
  const allDateRows = useMemo(() => filterRecords(records, { ...filters, start: '', end: '' }), [records, filters]);
  const departureYears = useMemo(() => [...new Set(records.flatMap(r => r.nodes.departure ? [r.nodes.departure.slice(0, 4)] : []))].sort(), [records]);
  const summary = useMemo(() => summarize(selectedRows), [selectedRows]);
  const counts = useMemo(() => coverage(selectedRows), [selectedRows]);
  const trendRows = useMemo(() => trend(selectedRows, granularity), [selectedRows, granularity]);
  const periods = useMemo(() => periodDomain(selectedRows, granularity, filters.start, filters.end), [selectedRows, granularity, filters.start, filters.end]);
  const comparison = useMemo(() => channelComparison(records, filters), [records, filters]);
  const unnamedChannelCount = useMemo(() => filterRecords(records, { ...filters, channel: 'unknown' }).filter(r => totalDays(r) !== null).length, [records, filters]);
  const overview = useMemo(() => regionalOverview(records, filters), [records, filters]);
  const warehousePicks = useMemo(() => {
    const n = new Map<string, number>();
    for (const row of selectedRows) if (totalDays(row) !== null && row.warehouse) n.set(row.warehouse, (n.get(row.warehouse) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [selectedRows]);
  const conclusionShare = useMemo(() => thresholdShare(selectedRows, summary?.p90 ?? 0), [selectedRows, summary]);
  const share = useMemo(() => thresholdShare(selectedRows, threshold), [selectedRows, threshold]);
  const stages = useMemo(() => stageSummary(selectedRows), [selectedRows]);
  const heatmap = useMemo(() => heatmapData(records, filters, granularity), [records, filters, granularity]);
  const allPeriods = useMemo(() => [...new Set([...periods, ...heatmap.periods])].sort(), [periods, heatmap.periods]);
  const chartWindow = periodWindow(allPeriods, windowOffset);
  const shownPeriods = chartWindow.periods;
  const shownHeatCells = heatmap.cells.filter(cell => shownPeriods.includes(cell.period));
  const heatColorMax = Math.max(5, Math.ceil(Math.max(...heatmap.cells.map(cell => cell.p90 ?? 0)) / 5) * 5);
  const periodRows = new Map(trendRows.map(row => [row.period, row]));
  const changeGranularity = (value: Granularity) => { setGranularity(value); setPeriod(''); setWindowOffset(0); };
  const validDates = selectedRows.filter(r => totalDays(r) !== null).map(r => r.nodes.departure!.slice(0, 10)).sort();
  const deliveredDates = selectedRows.filter(r => totalDays(r) !== null).map(r => r.nodes.delivered!.slice(0, 10)).sort();
  const actualRange = validDates.length ? `${validDates[0]} 至 ${validDates.at(-1)}` : '暂无有效样本';
  const channels = useMemo(() => [...new Set(records.map(r => r.channel))].filter(Boolean).sort(), [records]);
  const regions = useMemo(() => [...new Set(records.map(r => r.region))].filter(Boolean).sort(), [records]);
  const groups = useMemo(() => [...new Set(records.map(r => r.group))].filter(Boolean).sort(), [records]);
  const warehouseOptions = useMemo(() => [{ value: '', label: '全部渠道总览 · 输入代码、城市、州名或邮编查询' }, ...warehouses.map(w => ({ value: w.code, label: `${w.code} · ${warehouseLocation(w)}` }))], [warehouses]);
  const destinationWarehouse = warehouses.find(w => w.code === filters.warehouse);
  const operatorUnconfirmed = !!destinationWarehouse && records.some(r => r.warehouse === destinationWarehouse.code && r.flags.includes('warehouse_operator_unconfirmed'));
  const detailWarehouse = warehouses.find(w => w.code === selected?.warehouse);
  const mappingReview = useMemo(() => warehouses.filter(w => w.mappingStatus === 'pending').map(w => {
    const rows = records.filter(r => r.warehouse === w.code);
    return { code: w.code, n: rows.length, reason: w.reviewNote || (w.mappingConflict ? '字典存在多个定义，待核对' : '公开资料尚不足以确认实际仓址'),
      source: w.sourceRow ? `仓库详情 · 第 ${w.sourceRow} 行起` : rows[0] ? `${rows[0].source.sheet} · 第 ${rows[0].source.row} 行示例` : '—' };
  }).sort((a, b) => b.n - a.n), [warehouses, records]);
  const scopeLabel = `${filters.channel === 'unknown' ? '渠道未填写' : filters.channel || '全部渠道'} → ${filters.warehouse || '全部仓库'}`;
  const periodLabel = filters.start || filters.end ? `${filters.start || '最早'} 至 ${filters.end || '最新'}` : '全部开船日期';
  const detailRows = useMemo(() => selectedRows.filter(r => (!period || r.nodes.departure && periodKey(r.nodes.departure, granularity) === period) &&
    (detailStatus === 'all' || detailStatus === 'review' && r.flags.length > 0 || r.status === detailStatus)).sort((a, b) => (b.nodes.departure ?? '').localeCompare(a.nodes.departure ?? '')), [selectedRows, period, granularity, detailStatus]);
  const selectChannel = useCallback((channel: string) => updateFilters({ channel }), [updateFilters]);
  const selectWarehouse = useCallback((warehouse: string) => updateFilters({ warehouse }), [updateFilters]);
  const selectPeriod = useCallback((value: string) => { setPeriod(value); setDetailStatus('all'); setOpenPanels(keys => [...new Set([...keys, 'records'])]); }, []);
  const prepareReport = async () => {
    setTrendOpen(true);
    await document.fonts.ready;
    // Let React reveal the existing canvas and ResizeObserver finish the native chart resize.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const printReport = async () => {
    setPrinting(true);
    try { await prepareReport(); window.print(); }
    finally { setPrinting(false); }
  };
  const exportPng = async () => {
    if (!reportRef.current || !summary) return;
    setExporting(true);
    try {
      await prepareReport();
      const { toPng } = await import('html-to-image');
      const url = await toPng(reportRef.current, { pixelRatio: 2, backgroundColor: colors.canvas,
        filter: element => !(element instanceof HTMLElement && element.hasAttribute('data-export-hidden')) });
      const link = document.createElement('a'); link.download = `中航环球-${filters.warehouse || '全部仓库'}-${filters.channel || '全部渠道'}-历史时效.png`; link.href = url; link.click();
      messageApi.success('图片已生成，包含当前筛选范围及统计口径');
    } catch { messageApi.error('图片导出失败，请重试或使用打印 / PDF'); }
    finally { setExporting(false); }
  };
  const columns: TableColumnsType<TransitRecord> = [
    { title: '仓库 / 渠道', key: 'warehouse', width: 170, fixed: 'left', render: (_, r) => <div className="table-lines"><Button type="link" className="transit-record-link" onClick={() => setSelected(r)}>{r.warehouse || '未填写'} <ArrowRightOutlined /></Button><Text type="secondary">{r.channel || '渠道未填写'}</Text></div> },
    { title: '开船日期', key: 'departure', width: 124, render: (_, r) => displayDate(r.nodes.departure) },
    { title: '到港日期', key: 'arrival', width: 124, render: (_, r) => displayDate(r.nodes.arrival) },
    { title: '实际到仓', key: 'delivered', width: 124, render: (_, r) => displayDate(r.nodes.delivered) },
    { title: '实际时效', key: 'days', width: 94, render: (_, r) => <strong>{formatDays(totalDays(r))}{totalDays(r) !== null ? ' 天' : ''}</strong>, sorter: (a, b) => (totalDays(a) ?? -1) - (totalDays(b) ?? -1) },
    { title: '状态 / 待核', key: 'status', width: 240, render: (_, r) => <Space wrap size={[0, 4]}>{qualityStatus(r)}{r.flags.map(f => <Tag key={f}>{flagLabels[f]}</Tag>)}</Space> },
    { title: '原表位置', key: 'source', width: 150, render: (_, r) => `${r.source.sheet} · 第 ${r.source.row} 行` },
  ];
  return <div className={`transit-page${customerMode ? ' is-customer' : ''}`}>
    {messageContext}
    <div className="page-intro transit-page-intro no-print">
      <div><Title level={2}>中航环球 · 渠道时效</Title><p>开船 → 实际到亚马逊仓库 · 历史到仓表现</p></div>
      <Space wrap><Button icon={<DatabaseOutlined />} onClick={() => setSourceOpen(true)}>数据与口径</Button><Space size={8}><Text>客户展示</Text><Switch aria-label="客户展示" checked={customerMode} disabled={!isRoute} onChange={setCustomerMode} /></Space></Space>
    </div>
    <TransitControls filters={filters} dataThrough={manifest.dataThrough} warehouses={warehouseOptions} channels={channels} regions={regions} groups={groups} years={departureYears}
      onChange={patch => { updateFilters(patch); setCustomerMode(false); }} onReset={() => { updateFilters(defaultTransitFilters(manifest.dataThrough)); setCustomerMode(false); setOpenPanels([]); setTrendOpen(false); }} />
    <div className="transit-scope-bar no-print">
      <span>开船日期：<strong>{periodLabel}</strong>{filters.region && <> · {filters.region === 'unknown' ? '区域待核' : filters.region}</>}{filters.group && <> · {filters.group}</>}{filters.channel && <> · {filters.channel === 'unknown' ? '渠道未填写' : filters.channel}</>}</span>
      <span>最新已记录到仓日：<strong>{manifest.dataThrough}</strong></span>
    </div>
    {destinationWarehouse && !isRoute && <p className="transit-destination no-print" data-testid="transit-destination">{warehouseLocation(destinationWarehouse)}{operatorUnconfirmed && <><br />亚马逊与沃尔玛存在同名代码；显示亚马逊仓址，历史记录运营商仍待核。</>}</p>}
    {(filters.warehouse || filters.channel || filters.region || filters.group) && <Button className="transit-back no-print" type="link" icon={<LeftOutlined />} onClick={() => { updateFilters({ warehouse: '', channel: '', region: '', group: '' }); setCustomerMode(false); }}>公司渠道总览</Button>}
    {!filters.warehouse ? <div className="no-print">
      <ChannelOverview data={overview} region={filters.region} onSelect={(channel, region) => updateFilters({ channel, region, warehouse: '', group: '' })} />
      <div className="transit-warehouse-picks"><span>{filters.channel || filters.region ? `${[filters.channel, filters.region].filter(Boolean).join(' · ')}：选择目的仓，比较各渠道` : '常用目的仓'}</span>
        <Space wrap size={8}>{warehousePicks.map(([code]) => <Button key={code} onClick={() => updateFilters({ warehouse: code, channel: '', region: '', group: '' })}>{code}{warehouses.find(w => w.code === code)?.mappingStatus === 'pending' ? ' · 待核' : ''}</Button>)}</Space>
      </div>
    </div> : !customerMode && <div className="no-print"><WarehouseComparison warehouse={filters.warehouse} data={comparison} selected={filters.channel} unnamedCount={unnamedChannelCount} onSelect={selectChannel} onExpandRange={() => updateFilters({ start: '', end: '' })} /></div>}
    {!isRoute && <p className="transit-scope-count no-print">当前筛选有效到仓 <strong data-testid="transit-count">{num(summary?.n ?? 0)}条</strong>。{filters.warehouse ? '选择上方渠道查看线路摘要。' : '总览表比较美国三大区域；其他国家的亚马逊仓可按仓库或区域查询。'}</p>}
    {isRoute && <>
    <div ref={reportRef} className="transit-report" data-testid="transit-report">
      <div className="transit-report-heading"><div><span className="transit-report-brand">中航环球 <span>｜ 历史履约报告</span></span><h2>{scopeLabel}</h2><p>开船 → 实际到亚马逊仓库 · {periodLabel}</p>{(filters.region || filters.group) && <p>{[filters.region, filters.group].filter(Boolean).join(' · ')}</p>}</div><div className="transit-report-date">最新已记录到仓日<strong>{manifest.dataThrough}</strong></div></div>
      {destinationWarehouse && <p className="transit-destination" data-testid="transit-destination">{warehouseLocation(destinationWarehouse)}{operatorUnconfirmed && <><br />亚马逊与沃尔玛存在同名代码；显示亚马逊仓址，历史记录运营商仍待核。</>}</p>}
      {summary ? <>
        <div className="transit-kpis" aria-live="polite">
          <Metric label="典型到仓" value={formatDays(summary.median)} unit="天" note="中位数 · 一半已到仓记录在此天数内到仓" icon={<ClockCircleOutlined />} emphasized testId="transit-median" />
          <Metric label="90% 已到仓记录不超过" value={formatDays(summary.p90)} unit="天" note="历史样本统计 · 非未来时效承诺" icon={<BarChartOutlined />} testId="transit-p90" />
        </div>
        <p className="transit-conclusion">{scopeLabel}：典型到仓 <strong>{formatDays(summary.median)} 天</strong>，历史已到仓记录中 <strong>{((conclusionShare.rate ?? 0) * 100).toFixed(1)}%</strong> 在 <strong>{formatDays(summary.p90)} 天</strong>内到仓。</p>
      </> : <Card className="transit-empty"><Empty description="当前筛选条件下暂无有效到仓样本" /><p>调整仓库、渠道或开船日期；未回填和异常记录仍可在下方明细查看。</p><Button onClick={() => updateFilters({ start: '', end: '' })}>查看全部历史</Button></Card>}
      <div className="transit-report-samples">依据 <strong data-testid="transit-count">{num(summary?.n ?? 0)}条</strong> 有效到仓记录 · {num(counts.trips)} 个独立柜次 · 当前样本最晚到仓 {deliveredDates.at(-1) ?? '—'}
        {(counts.unknown > 0 || counts.invalid > 0) && <span>另有 {counts.unknown} 条到仓未回填、{counts.invalid} 条日期异常，未计入时效指标。</span>}
      </div>
      {summary && summary.n < 10 && <Alert className="transit-notice" type="warning" showIcon message="样本较少：当前不足 10 条，仅供查看记录，不据此判断长期稳定性。" action={<Button size="small" onClick={() => updateFilters({ start: '', end: '' })}>查看全部历史</Button>} />}
      {summary && <>
        <Button type="link" className="transit-trend-toggle no-print" data-export-hidden aria-expanded={trendOpen || customerMode} aria-controls="transit-trend-content" onClick={() => setTrendOpen(value => !value)}>{trendOpen || customerMode ? '收起时效趋势' : '查看时效趋势'}</Button>
        <div id="transit-trend-content" className="transit-trend-content" hidden={!trendOpen && !customerMode}>
        <Card className="transit-panel transit-trend-panel" title={<div><span>每{granularity === 'week' ? '周' : '月'}开船，到仓要多久</span><small>实线看典型时效，虚线看 90% 记录到仓所需天数</small></div>} extra={<Segmented data-export-hidden className="no-print" aria-label="时间粒度" value={granularity} options={[{ label: '按周', value: 'week' }, { label: '按月', value: 'month' }]} onChange={changeGranularity} />}>
          <PeriodNavigator periods={shownPeriods} allPeriods={allPeriods} granularity={granularity} page={chartWindow.page} pages={chartWindow.pages} onChange={setWindowOffset} />
          <TrendChart data={trendRows} periods={shownPeriods} granularity={granularity} onSelect={customerMode ? undefined : selectPeriod} />
          <div className="transit-sample-strip" aria-label="各期到仓样本数"><span>样本</span><div style={{ gridTemplateColumns: `repeat(${shownPeriods.length}, minmax(0, 1fr))` }}>{shownPeriods.map(key => <Tooltip key={key} title={`${formatPeriod(key, granularity)} · ${periodRows.get(key)?.n ?? 0} 条有效记录`}><button type="button" disabled={customerMode || !periodRows.has(key)} onClick={() => selectPeriod(key)} aria-label={`${formatPeriod(key, granularity)}，${periodRows.get(key)?.n ?? 0} 条记录`} className={period === key ? 'selected' : ''}>{periodRows.get(key)?.n ?? '—'}</button></Tooltip>)}</div></div>
          <div className="transit-chart-foot"><span>{granularity === 'week' ? '按开船周：周一至周日' : '按开船月份'} · 首尾期按筛选日期截取 · 无样本时断开</span><span>单期不足 10 条谨慎比较；摘要统计整个所选期间，翻页仅切换图表窗口</span></div>
          <Collapse ghost className="no-print" data-export-hidden items={[{ key: 'table', label: '查看各期数值与样本数', children: <Table size="small" pagination={{ pageSize: 12, showSizeChanger: false }} rowKey="period" dataSource={trendRows} scroll={{ x: 620 }} columns={[
            { title: '开船期间', dataIndex: 'period', render: (value: string) => formatPeriod(value, granularity) }, { title: '记录数', dataIndex: 'n', render: (n: number) => <>{n} 条 {n < 10 && <Tag>样本较少</Tag>}</> },
            { title: '中位数 / 天', dataIndex: 'median', render: formatDays }, { title: 'P90 / 天', dataIndex: 'p90', render: formatDays }, { title: '最慢 / 天', dataIndex: 'max', render: formatDays },
          ]} /> }]} />
        </Card>

        </div>
      </>}
      <div className="transit-report-foot">历史统计不代表未来每批时效；不是收货起算，也不代表亚马逊上架时间。<br />有效样本开船日期：{actualRange} · 按到仓记录计数 · 数据覆盖日不代表所有批次已完成回填</div>
    </div>
    <div className="transit-export-actions no-print"><span>导出当前线路摘要与时效趋势</span><Space wrap><Button icon={<DownloadOutlined />} loading={exporting} disabled={!summary || printing} onClick={exportPng}>导出报告 PNG</Button><Button icon={<PrinterOutlined />} loading={printing} disabled={!summary || exporting} onClick={printReport}>打印 / 保存 PDF</Button></Space></div>
    </>}
    {!customerMode && <div className="transit-analysis no-print">
      <Collapse className="transit-analysis-collapse" activeKey={openPanels} onChange={keys => setOpenPanels(typeof keys === 'string' ? [keys] : keys)} items={[
        ...(filters.warehouse ? [{ key: 'comparison', label: '渠道对比图', children: <>        <Card className="transit-panel" title={filters.warehouse ? `${filters.warehouse} · 同仓渠道比较` : '同仓渠道比较'} extra={<Tooltip title="比较使用相同仓库、区域、组合及日期范围，保留所有渠道。不同渠道拥有的实际航次不同。"><InfoCircleOutlined /></Tooltip>}>
          {filters.warehouse && comparison.length ? <><ComparisonChart data={comparison} selected={filters.channel} onSelect={selectChannel} /><div className="transit-channel-picks">{comparison.map(s => <Button key={s.channel} type={s.channel === filters.channel ? 'primary' : 'default'} size="small" onClick={() => selectChannel(s.channel)}>{s.channel} · {s.n} 条</Button>)}</div></> : <Empty description={filters.warehouse ? '此仓库暂无可比较的记录' : '先选择一个具体仓库，进行同口径比较'} />}
        </Card>
</> }] : []),
        ...(isRoute ? [{ key: 'stages', label: '运输环节耗时', children: <>        <Card className="transit-panel" title="时间，花在哪个环节" extra={<span className="transit-panel-subtitle">共同完整样本 {stages.n} 条</span>}>
          <StageChart data={stages.data} /><div className="transit-stage-values">{stages.data.map(s => <div key={s.stage}><span>{s.stage}</span><strong>{formatDays(s.days)} <small>天</small></strong></div>)}</div>
          <p className="transit-method-note">同一组完整、先后合理的到仓记录，按记录加权的分段平均值合计 {formatDays(stages.mean)} 天。缺失节点不补零；同柜多仓记录可能共享海运节点。</p>
        </Card>
</> }, { key: 'evidence', label: '按指定天数查看到仓占比', children: <>        <Card className="transit-panel transit-evidence" title="按指定天数查看到仓占比" extra={<span className="transit-panel-subtitle">已到仓记录内占比</span>}>
          <div className="transit-threshold-control" data-export-hidden><label className="no-print">观察阈值<InputNumber aria-label="观察天数" min={1} max={365} precision={0} value={threshold} onChange={value => { if (value !== null) setThreshold(value); }} />天</label><span>自定义观察天数，不作为承诺达成率</span></div>
          {share.n ? <p className="transit-evidence-copy">{scopeLabel}，<strong>{share.within} / {share.n}</strong> 条已到仓记录在 <strong>{threshold} 天</strong>内到仓，占 <strong>{((share.rate ?? 0) * 100).toFixed(1)}%</strong>。</p> : <Empty description="暂无已到仓样本，无法计算占比" />}
          <p className="transit-method-note">有效样本开船日期：{actualRange}。当前样本最晚到仓：{deliveredDates.at(-1) ?? '—'}。图表按开船日期归属，到仓日期不会作为横轴。未回填与日期异常不进入该占比；重复候选暂保留。历史表现不代表未来每批时效。</p>
        </Card>
</> }] : []),
        { key: 'warehouses', label: '各仓库时效分布', children: <>      <Card className="transit-panel transit-distribution-panel" title={<div><span>{`${filters.channel && filters.channel !== 'unknown' ? filters.channel + ' · ' : ''}仓库时效分布`}</span><small>每列为一个开船{granularity === 'week' ? '周' : '月'} · 数字为 90% 记录到仓天数</small></div>} extra={<Segmented aria-label="分布时间粒度" value={granularity} options={[{ label: '按周', value: 'week' }, { label: '按月', value: 'month' }]} onChange={changeGranularity} />}>
        {filters.channel ? <><PeriodNavigator periods={shownPeriods} allPeriods={allPeriods} granularity={granularity} page={chartWindow.page} pages={chartWindow.pages} onChange={setWindowOffset} /><WarehouseHeatmap cells={shownHeatCells} warehouses={heatmap.warehouses} periods={shownPeriods} granularity={granularity} colorMax={heatColorMax} onSelect={selectWarehouse} /><p className="transit-method-note">在当前渠道、区域、组合和日期范围内，显示样本最多的 10 个已匹配仓库（保留已选仓库）；颜色越深表示天数越多，灰色表示无样本。翻页保持同一色阶，点击单元格切换仓库，悬浮查看样本量。</p></> : <Empty description="选择一个渠道后，查看各仓库随时间的表现" />}
      </Card>
</> },
        { key: 'records', label: `原始明细与数据核对 · ${num(counts.total)} 条`, children: <>
          <div className="transit-coverage-line"><span>所选源表记录 {num(counts.total)} 条</span><span>到仓未回填 {counts.unknown} 条</span><span>日期异常 {counts.invalid} 条</span><span>疑似重复涉及 {counts.duplicateRows} 条（暂保留）</span>{counts.unverified > 0 && <span>仓库映射待核 {counts.unverified} 条</span>}</div>
          {(filters.start || filters.end) && <p className="transit-filter-hint" data-testid="transit-date-filter-hint">当前仓库、渠道等条件在全部时间共有 {num(allDateRows.length)} 条，开船日期筛选后显示 {num(selectedRows.length)} 条；另有 {num(allDateRows.length - selectedRows.length)} 条在日期范围外。<Button type="link" size="small" onClick={() => updateFilters({ start: '', end: '' })}>清除日期限制</Button></p>}
                <Card className="transit-panel transit-details-card" title="每一条记录，都可以追溯" extra={<Select aria-label="明细状态" value={detailStatus} onChange={setDetailStatus} options={[{ value: 'all', label: '全部记录' }, { value: 'arrived', label: '已到仓' }, { value: 'unknown', label: '到仓未回填' }, { value: 'invalid', label: '日期异常' }, { value: 'review', label: '有待核标记' }]} />}>
        <div className="transit-table-summary"><span>{num(detailRows.length)} 条记录 · 点击仓库查看节点时间轴</span>{period && <Tag closable onClose={() => setPeriod('')}>开船期间：{formatPeriod(period, granularity)}</Tag>}</div>
        <Table<TransitRecord> key={`${JSON.stringify(filters)}-${period}-${detailStatus}`} columns={columns} dataSource={detailRows} rowKey="id" size="small" scroll={{ x: 1120 }} pagination={{ pageSize: 10, showSizeChanger: false, showTotal: n => `共 ${num(n)} 条` }} locale={{ emptyText: '当前条件下没有明细记录' }} />
      </Card>

        </> },
      ]} />
    </div>}
    <Modal open={sourceOpen} title="数据来源与统计口径" onCancel={() => setSourceOpen(false)} footer={<Button onClick={() => setSourceOpen(false)}>关闭</Button>} width={760}>
      <Descriptions size="small" bordered column={1} items={[
        { key: 'source', label: '源文件', children: manifest.sourceFile }, { key: 'range', label: '有效开船范围', children: manifest.departureRange.join(' 至 ') },
        { key: 'through', label: '数据覆盖至', children: `${manifest.dataThrough}（最新已记录到仓日）` }, { key: 'generated', label: '数据提取时间', children: dayjs(manifest.generatedAt).format('YYYY-MM-DD HH:mm') },
        { key: 'sheets', label: '明细来源', children: manifest.sheets.map(s => <div key={s.sheet}>{s.sheet}：原始 {num(s.businessRows)} 条，保留 {num(s.includedRows)} 条，排除 {num(s.excludedRows)} 条；跳过 {s.skippedRows} 行非业务内容</div>) },
        { key: 'exclusions', label: '亚马逊范围清理', children: `原始 ${num(manifest.counts.records + manifest.exclusions.records)} 条 = 保留 ${num(manifest.counts.records)} 条 + 排除 ${num(manifest.exclusions.records)} 条（${manifest.exclusions.codes} 个非亚马逊仓或非具体仓库标记）。源文件未改写，排除行留有本地审计。` },
        { key: 'locations', label: '仓址核对', children: `${manifest.warehouseReviewedAt}：待核项按公开实际仓址补充城市、中文州/省名及邮编；已匹配项补入源表邮编。欧洲亚马逊仓保留并单列区域；业务组合缺项不猜填。` },
        { key: 'counts', label: '数量核对', children: `${num(manifest.counts.records)} 条 = ${num(manifest.counts.arrived)} 条日期有效到仓 + ${manifest.counts.unknown} 条未回填 + ${manifest.counts.invalid} 条日期异常` },
        { key: 'dups', label: '重复候选', children: `${manifest.counts.duplicateGroups} 组，多出 ${manifest.counts.duplicateExtraRows} 行，暂保留全部并标记，不自动删减` },
        { key: 'definition', label: '统计定义', children: '从开船到实际送达亚马逊仓库，按到仓记录计数；不是订单数。中位数取中间位置，P10/P90采用最近秩法；保留日期中的时分秒，按经过秒数 / 86400 计算。' },
        { key: 'period', label: '周与月', children: '按开船日期归属。每周从周一到周日，跨月、跨年仍属于同一周；每月按自然月。无样本期间留空。图表每页 12 期，翻页与切换粒度不改变指标卡的统计范围。' },
        { key: 'rules', label: '阈值与赔付', children: '提醒时效与赔付时效不等于已确认的历史承诺。规则生效期和赔付边界尚未核实，本页不生成“准时率”。' },
      ]} />
      <p className="transit-method-note">样本不足 10 条时提示“样本较少”。未回填可能是仍在途或漏录，无法据此判定准时或延误。真实长时效保留；节点异常仅影响相关环节计算。仓库映射待核不会自动修正代码。</p>
      <Collapse ghost items={[{ key: 'mapping', label: `“仓库映射待核”具体是什么？${mappingReview.length} 个代码，${num(mappingReview.reduce((sum, row) => sum + row.n, 0))} 条记录`, children: <><p className="transit-method-note">以下代码仍缺少可靠仓址证据，保留原始写法并标记待核。日期有效的记录仍参与总时效与具体仓库统计；未确认区域的记录不进入已匹配仓库热力图。已核实城市但缺少内部业务组合的仓库可正常按地理区域统计，组合保持空白。</p><Table size="small" rowKey="code" dataSource={mappingReview} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 580 }} columns={[{ title: '代码', dataIndex: 'code' }, { title: '记录数', dataIndex: 'n' }, { title: '原因', dataIndex: 'reason' }, { title: '原表位置', dataIndex: 'source' }]} /></> }]} />
      <Space wrap>{Object.entries(manifest.flags).map(([flag, n]) => <Tag key={flag}>{flagLabels[flag as keyof typeof flagLabels] ?? flag}：{n}</Tag>)}</Space>
    </Modal>
    <Drawer open={!!selected} title={selected ? `${selected.warehouse} · ${selected.channel || '渠道未填写'}` : ''} onClose={() => setSelected(null)} width={520}>
      {selected && <><div className="transit-drawer-total"><span>开船至实际到仓</span><strong>{formatDays(totalDays(selected))}<small> 天</small></strong>{qualityStatus(selected)}</div>
        <Timeline items={Object.entries(nodeLabels).map(([key, label]) => ({ color: selected.nodes[key as keyof typeof nodeLabels] ? colors.primary : colors.textMuted, children: <div><strong>{label}</strong><p>{displayDate(selected.nodes[key as keyof typeof nodeLabels])}</p></div> }))} />
        <Descriptions column={1} size="small" items={[{ key: 'source', label: '原表位置', children: `${selected.source.sheet} · 第 ${selected.source.row} 行` },
          { key: 'location', label: '目的仓所在地', children: detailWarehouse ? warehouseLocation(detailWarehouse) : '待核' },
          { key: 'address', label: '仓库地址', children: detailWarehouse?.address || '待核' },
          { key: 'address-source', label: '仓址依据', children: detailWarehouse?.addressSource === 'web' ? <Space wrap>{detailWarehouse.referenceUrls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">公开来源 {i + 1}</a>)}<span>核对于 {detailWarehouse.reviewedAt}</span></Space> : detailWarehouse?.sourceRow ? `原表仓库详情第 ${detailWarehouse.sourceRow} 行` : '公开资料尚不足以确认' },
          ...(detailWarehouse?.reviewNote ? [{ key: 'address-note', label: '仓址说明', children: detailWarehouse.reviewNote }] : []),
          { key: 'group', label: '渠道组合', children: selected.channelGroup || '未匹配' },
          { key: 'trip', label: '匿名柜次', children: selected.containerTripId || '未识别' },
          { key: 'rule', label: '当前表内参考规则', children: (() => { const rule = rules.find(r => r.group === selected.channelGroup); return rule ? `提醒 ${rule.reminderDays} 天；赔付参考 ${rule.compensationDays} 天（非已核实历史承诺）` : '没有可匹配的规则'; })() },
        ]} /><Space wrap>{selected.flags.map(flag => <Tag key={flag} color="warning">{flagLabels[flag]}</Tag>)}</Space>
        <p className="transit-method-note">未回填的文字备注不推断为实际日期。原始柜号与内部备注不随公开数据发布，业务核对请使用原表位置。</p></>}
    </Drawer>
  </div>;
}

function Metric({ label, value, unit, note, icon, emphasized, testId }: { label: string; value: string; unit: string; note: string; icon: React.ReactNode; emphasized?: boolean; testId?: string }) {
  return <div className={`transit-metric${emphasized ? ' transit-metric-emphasis' : ''}`}><div className="transit-metric-label">{label}<span>{icon}</span></div><div className="transit-metric-value" data-testid={testId}>{value}<small>{unit}</small></div><p>{note}</p></div>;
}

function PeriodNavigator({ periods, allPeriods, granularity, page, pages, onChange }: { periods: string[]; allPeriods: string[]; granularity: Granularity; page: number; pages: number; onChange: (page: number) => void }) {
  if (!periods.length) return null;
  const unit = granularity === 'week' ? '周' : '月';
  return <div className="transit-period-navigation"><div className="transit-period-nav"><div><span className="transit-period-badge">按{unit}</span><strong>{periods[0]}{granularity === 'month' ? '-01' : ''} — {periodEnd(periods.at(-1)!, granularity)}</strong><span>本页 {periods.length} {unit} / 共 {allPeriods.length} {unit}</span></div><Space wrap size={6} className="no-print" data-export-hidden><Button size="small" disabled={page >= pages - 1} onClick={() => onChange(pages - 1)} aria-label={`最早的开船${unit}`}>最早</Button><Button size="small" icon={<LeftOutlined />} disabled={page >= pages - 1} onClick={() => onChange(page + 1)} aria-label={`更早的开船${unit}`}>更早</Button><Button size="small" disabled={page === 0} onClick={() => onChange(0)}>最新</Button><Button size="small" icon={<RightOutlined />} disabled={page === 0} onClick={() => onChange(page - 1)} aria-label={`更近的开船${unit}`}>更近</Button></Space></div><p className="transit-calendar-coverage no-print" data-export-hidden>图表完整范围：{allPeriods[0]} 至 {periodEnd(allPeriods.at(-1)!, granularity)} · 第 {pages - page} / {pages} 页，默认展示最新时段；可向前查看历史。</p></div>;
}
