import { lazy } from 'react';
import { ContainerOutlined, SearchOutlined } from '@ant-design/icons';

const QuoteV2Page = lazy(() => import('../features/quotes-v2/QuoteV2Page'));

/** One registry for routes, navigation, breadcrumb and document titles. */
export const appRoutes = [
  {
    path: '/',
    label: '多渠道成本比价',
    breadcrumb: '各渠道成本与附加费',
    icon: <SearchOutlined />,
    badge: '按入仓数据复算',
    badgeIcon: <ContainerOutlined />,
    Component: QuoteV2Page,
  },
];
