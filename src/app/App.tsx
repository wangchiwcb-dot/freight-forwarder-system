import { useState } from 'react';
import { Button, ConfigProvider, Layout, Menu, Space, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { CloudDownloadOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { QuoteSearchPage } from '../features/quotes/QuoteSearchPage';

const { Header, Sider, Content } = Layout;

function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Layout className="application">
      <Sider width={208} collapsedWidth={0} breakpoint="lg" onBreakpoint={setCollapsed} trigger={null} collapsed={collapsed} className="app-sider">
        <div className="brand"><span className="brand-mark">ZH</span><div><span className="brand-title">中航环球</span><span className="brand-subtitle">FREIGHT DESK</span></div></div>
        <div className="sidebar-label">采购工作台</div>
        <Menu theme="dark" mode="inline" selectedKeys={['quotes']} items={[{ key: 'quotes', icon: <SearchOutlined />, label: '渠道报价台' }]} />
        <div className="sider-footer"><span className="workspace-dot">内部采购报价</span><span>深圳中航环球国际货运代理</span></div>
      </Sider>
      <Layout className="workspace-layout">
        <Header className="app-header">
          <Space size={12}><Button type="text" aria-label={collapsed ? '展开菜单' : '收起菜单'} className="collapse-btn" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((value) => !value)} /><Typography.Text type="secondary">采购管理 <span className="breadcrumb-slash">/</span> <span className="breadcrumb-current">报价查询</span></Typography.Text></Space>
          <Space size={14}><Tag className="header-data-tag" icon={<CloudDownloadOutlined />}>本地数据</Tag><span className="user-avatar">ZH</span></Space>
        </Header>
        <Content className="app-content"><Routes><Route path="/" element={<QuoteSearchPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Content>
      </Layout>
    </Layout>
  );
}

export function App() {
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#0b887c', colorInfo: '#0b887c', borderRadius: 9, colorText: '#203440', colorTextSecondary: '#73838d', colorBorder: '#dfe6e9', controlHeight: 38, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif' }, components: { Layout: { bodyBg: '#f4f7f8', siderBg: '#132632', headerBg: '#ffffff' }, Menu: { darkItemBg: '#132632', darkItemSelectedBg: '#25434a', darkItemSelectedColor: '#99ece0', itemHeight: 44, itemMarginInline: 12 }, Table: { headerBg: '#f7f9fa', headerColor: '#72818a', fontSize: 13 }, Card: { paddingLG: 22 } } }}><ErrorBoundary><AppShell /></ErrorBoundary></ConfigProvider>;
}
