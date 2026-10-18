import { useEffect, useState } from 'react';
import { Button, DatePicker, Select } from 'antd';
import { ReloadOutlined, SlidersOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { relativeRange, type TransitFilters } from './metrics';

export function TransitControls({ filters, dataThrough, warehouses, channels, regions, groups, years, onChange, onReset }: {
  filters: TransitFilters; dataThrough: string; warehouses: { value: string; label: string }[];
  channels: string[]; regions: string[]; groups: string[]; years: string[];
  onChange: (patch: Partial<TransitFilters>) => void; onReset: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [custom, setCustom] = useState(false);
  useEffect(() => { setCustom(false); }, [filters.start, filters.end]);
  const ranges = [180, 90].map(days => ({ value: String(days), label: `截至数据日近 ${days} 天`, range: relativeRange(dataThrough, days) }));
  const preset = !filters.start && !filters.end ? 'all' : ranges.find(r => r.range[0] === filters.start && r.range[1] === filters.end)?.value
    ?? years.find(year => filters.start === `${year}-01-01` && filters.end === `${year}-12-31`) ?? 'custom';
  const active = [filters.region, filters.group, filters.channel].filter(Boolean).length;
  return <div className="transit-controls no-print">
    <div className="transit-search-row">
      <label className="transit-warehouse-search">你要发到哪个仓库？<Select aria-label="目的仓库" showSearch optionFilterProp="label" value={filters.warehouse}
        options={warehouses} onChange={warehouse => onChange({ warehouse, channel: '', region: '', group: '' })} /></label>
      <label className="transit-time-search">统计时间<Select aria-label="统计时间" value={custom ? 'custom' : preset}
        options={[...ranges.map(({ value, label }) => ({ value, label })), { value: 'all', label: '全部历史' }, ...years.map(year => ({ value: year, label: `${year} 年` })), { value: 'custom', label: '自定义开船日期' }]}
        onChange={value => {
          setCustom(value === 'custom');
          if (value === 'custom') return;
          const range = ranges.find(r => r.value === value)?.range;
          onChange(range ? { start: range[0], end: range[1] } : value === 'all' ? { start: '', end: '' } : { start: `${value}-01-01`, end: `${value}-12-31` });
        }} /></label>
      <Button icon={<SlidersOutlined />} aria-expanded={advanced} aria-controls="transit-more-filters" onClick={() => setAdvanced(value => !value)}>更多筛选{active ? ` (${active})` : ''}</Button>
      <Button type="text" icon={<ReloadOutlined />} onClick={() => { onReset(); setCustom(false); }}>重置</Button>
    </div>
    {(custom || preset === 'custom') && <div className="transit-custom-range"><label>开船日期<DatePicker.RangePicker aria-label="开船日期范围"
      value={[filters.start ? dayjs(filters.start) : null, filters.end ? dayjs(filters.end) : null]}
      onChange={dates => onChange({ start: dates?.[0]?.format('YYYY-MM-DD') ?? '', end: dates?.[1]?.format('YYYY-MM-DD') ?? '' })} allowClear /></label></div>}
    {advanced && <div className="transit-filter-grid" id="transit-more-filters">
      <label>仓库区域<Select aria-label="仓库区域" value={filters.region} options={[{ value: '', label: '全部区域' }, ...regions.map(value => ({ value, label: value })), { value: 'unknown', label: '区域待核' }]}
        onChange={region => onChange({ region, warehouse: '', group: '' })} /></label>
      <label>仓库组合<Select aria-label="仓库组合" value={filters.group} options={[{ value: '', label: '全部组合' }, ...groups.map(value => ({ value, label: value }))]}
        onChange={group => onChange({ group, warehouse: '' })} /></label>
      <label>运输渠道<Select aria-label="运输渠道" value={filters.channel} options={[{ value: '', label: '全部渠道' }, ...channels.map(value => ({ value, label: value })), { value: 'unknown', label: '渠道未填写' }]}
        onChange={channel => onChange({ channel })} /></label>
    </div>}
  </div>;
}
