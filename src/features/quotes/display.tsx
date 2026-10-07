import { Tag } from 'antd';
import { ApartmentOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import type { Quote } from '../../domain/types';

export function formatMoney(amount: number | null, currency: Quote['currency']) {
  if (amount === null) return '—';
  const symbols = { CNY: '¥', USD: 'US$', EUR: '€', GBP: '£' };
  return `${currency ? symbols[currency] : ''}${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function formatDate(value: string | null) { return value?.slice(0, 10) || '未标注'; }
export function unitLabel(quote: Quote) { return ({ kg: 'kg', cbm: 'CBM', parcel: '件/票', first_increment: '首续重', unknown: '待核' })[quote.billingBasis]; }
export function BillingTag({ quote }: { quote: Quote }) {
  const labels = { kg: '按重量 KG', cbm: '按体积 CBM', parcel: '按件/票', first_increment: '首续重', unknown: '计费待核' };
  return <Tag className="billing-tag" color={quote.billingBasis === 'cbm' ? 'cyan' : quote.billingBasis === 'kg' ? 'blue' : undefined} icon={quote.billingBasis === 'cbm' ? <ApartmentOutlined /> : undefined}>{labels[quote.billingBasis]}</Tag>;
}
export function ReliabilityTag({ quote }: { quote: Quote }) {
  if (quote.reliability.level === 'verified') return <Tag color="success" icon={<CheckCircleOutlined />}>已验证</Tag>;
  if (quote.reliability.level === 'concern') return <Tag color="warning" icon={<ExclamationCircleOutlined />}>有风险记录</Tag>;
  return <span className="muted-status"><span />待积累</span>;
}
