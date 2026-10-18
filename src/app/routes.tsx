import { lazy } from 'react';
import {
  BarChartOutlined,
  CloudDownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';

const QuoteSearchPage = lazy(() =>
  import('../features/quotes/QuoteSearchPage').then((module) => ({
    default: module.QuoteSearchPage,
  })),
);
const TransitPage = lazy(() => import('../features/transit/TransitPage'));

/** One registry for routes, navigation, breadcrumb and document titles. */
export const appRoutes = [
  {
    path: '/',
    label: '渠道报价台',
    breadcrumb: '报价查询',
    icon: <SearchOutlined />,
    badge: '云端报价库',
    badgeIcon: <CloudDownloadOutlined />,
    Component: QuoteSearchPage,
  },
  {
    path: '/transit',
    label: '渠道时效',
    breadcrumb: '渠道时效',
    icon: <BarChartOutlined />,
    badge: '历史时效数据',
    badgeIcon: <BarChartOutlined />,
    Component: TransitPage,
  },
];
