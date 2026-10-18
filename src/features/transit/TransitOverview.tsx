import { useState } from 'react';
import { Button, Empty, Tag } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { formatDays, overviewRegions, type regionalOverview, type Summary } from './metrics';

export function ChannelOverview({ data, region, onSelect }: {
  data: ReturnType<typeof regionalOverview>; region: string;
  onSelect: (channel: string, region: string) => void;
}) {
  const [mobileRegion, setMobileRegion] = useState<string>('美西');
  const columns = overviewRegions.filter(value => !region || region === value);
  const visibleRegion = region || mobileRegion;
  return <section className="transit-overview" aria-labelledby="transit-overview-title" data-testid="transit-overview">
    <div className="transit-section-heading">
      <div><h2 id="transit-overview-title">公司渠道时效总览</h2><p>先看各区域大致多久到，再选目的仓比较渠道。</p></div>
      <span className="transit-section-hint">典型到仓 = 中位数</span>
    </div>
    {columns.length > 1 && <div className="transit-mobile-regions" role="group" aria-label="总览显示区域">{columns.map(value => <Button key={value} size="small" type={visibleRegion === value ? 'primary' : 'default'} aria-pressed={visibleRegion === value} onClick={() => setMobileRegion(value)}>{value}</Button>)}</div>}
    {columns.length && data.rows.length ? <div className="transit-matrix-scroll">
      <table className="transit-matrix">
        <caption className="sr-only">各渠道按目的区域的历史到仓时效，单位为天</caption>
        <thead><tr><th scope="col">运输渠道</th>{columns.map(value => <th key={value} scope="col" className={visibleRegion === value ? 'is-mobile-region' : 'transit-desktop-region'}>{value}</th>)}</tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.channel}>
          <th scope="row">{row.channel}</th>
          {columns.map(value => {
            const summary = row.cells.find(cell => cell.region === value)?.summary;
            return <td key={value} className={visibleRegion === value ? 'is-mobile-region' : 'transit-desktop-region'}>{summary ? <button className="transit-matrix-cell" type="button"
              aria-label={`${row.channel} · ${value}，典型 ${formatDays(summary.median)} 天，查看目的仓`}
              onClick={() => onSelect(row.channel, value)}>
              <span className="transit-cell-primary"><strong>{formatDays(summary.median)}</strong> 天<span>典型到仓</span></span>
              <span className="transit-cell-secondary">90% 已到仓记录 ≤ {formatDays(summary.p90)} 天</span>
              <span className="transit-cell-samples">{summary.n.toLocaleString('zh-CN')} 条{summary.n < 10 && <span className="transit-low-sample"> · 样本较少</span>}<ArrowRightOutlined /></span>
            </button> : <div className="transit-cell-empty">暂无样本</div>}</td>;
          })}
        </tr>)}</tbody>
      </table>
    </div> : <Empty description="当前条件没有可按区域展示的渠道样本" />}
    <p className="transit-method-note">区域内包含不同仓库，仅描述历史样本分布；具体时效请选目的仓。暂无样本不代表渠道不提供服务。
      {data.excluded > 0 && <> 另有 {data.excluded.toLocaleString('zh-CN')} 条渠道、区域或仓库映射待核记录未进入总览，可在下方明细核对。</>}
    </p>
  </section>;
}

export function WarehouseComparison({ warehouse, data, selected, unnamedCount, onSelect, onExpandRange }: {
  warehouse: string; data: (Summary & { channel: string })[]; selected: string;
  unnamedCount: number;
  onSelect: (channel: string) => void; onExpandRange: () => void;
}) {
  return <section className="transit-comparison" data-testid="transit-comparison" aria-labelledby="transit-comparison-title">
    <div className="transit-section-heading"><div><h2 id="transit-comparison-title">发到 {warehouse}，各渠道多久到？</h2><p>同一目的仓、同一统计期间 · 点击渠道查看详细表现</p></div></div>
    {data.length ? <div className="transit-comparison-cards">{data.map(row => <button type="button" key={row.channel}
      className={`transit-channel-card${selected === row.channel ? ' is-selected' : ''}`} aria-pressed={selected === row.channel}
      aria-label={`查看${row.channel}到${warehouse}的时效详情`} onClick={() => onSelect(row.channel)}>
      <span className="transit-channel-name">{row.channel}{row.n < 10 && <Tag color="warning">样本较少</Tag>}<ArrowRightOutlined /></span>
      <span className="transit-channel-main"><strong>{formatDays(row.median)}</strong> 天<span>典型到仓</span></span>
      <span className="transit-channel-secondary">90% 已到仓记录不超过 <b>{formatDays(row.p90)} 天</b></span>
      <span className="transit-channel-samples">{row.n.toLocaleString('zh-CN')} 条有效到仓记录 · {selected === row.channel ? '已选中' : '查看详情'}</span>
    </button>)}</div> : <Empty description="当前期间，此仓库暂无可比较的渠道记录"><Button onClick={onExpandRange}>查看全部历史</Button></Empty>}
    {data.some(row => row.n < 10) && <p className="transit-method-note">样本不足 10 条的渠道仅供查看记录，不据此判断长期稳定性。可扩大统计时间范围。</p>}
    {unnamedCount > 0 && <p className="transit-method-note">另有 {unnamedCount} 条有效到仓记录未填写渠道，未进入上方比较。<Button type="link" size="small" onClick={() => onSelect('unknown')}>查看渠道未填写记录</Button></p>}
  </section>;
}
