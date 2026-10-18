import type { TransitWarehouse } from './data';

const countries: Record<string, string> = { US: '美国', DE: '德国', PL: '波兰', FR: '法国' };

export function warehouseLocation(warehouse: TransitWarehouse): string {
  const state = warehouse.stateNameZh ? `${warehouse.stateNameZh}（${warehouse.state}）` : warehouse.state || '州/省待核';
  return [countries[warehouse.country] || warehouse.country, warehouse.city.replace(/\s+/g, ' ') || '城市待核', state,
    warehouse.postalCode ? `邮编 ${warehouse.postalCode}` : '邮编待核'].filter(Boolean).join(' · ');
}
