import { Suspense, useEffect, useState } from 'react';
import {
  Button,
  ConfigProvider,
  Layout,
  Menu,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { appTheme } from '../theme/antd';
import { appRoutes } from './routes';

const { Header, Sider, Content } = Layout;

function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute =
    appRoutes.find((route) => route.path === location.pathname) ?? appRoutes[0];
  useEffect(() => {
    document.title = `中航环球 · ${currentRoute.label}`;
  }, [currentRoute.label]);
  return (
    <Layout className="application">
      <Sider
        width={216}
        collapsedWidth={0}
        breakpoint="lg"
        onBreakpoint={setCollapsed}
        trigger={null}
        collapsed={collapsed}
        className="app-sider"
        aria-label="工作台导航"
        inert={collapsed}
      >
        <div className="brand flex items-center gap-3">
          <span className="brand-mark grid place-items-center">ZH</span>
          <div>
            <span className="brand-title">中航环球</span>
            <span className="brand-subtitle">FREIGHT DESK</span>
          </div>
        </div>
        <div className="sidebar-label">采购工作台</div>
        <Menu
          mode="inline"
          selectedKeys={[currentRoute.path]}
          onClick={({ key }) => navigate(key)}
          items={appRoutes.map((route) => ({
            key: route.path,
            icon: route.icon,
            label: route.label,
          }))}
        />
        <div className="sider-footer flex flex-col gap-2">
          <span className="workspace-dot">内部采购报价</span>
          <span>深圳中航环球国际货运代理</span>
        </div>
      </Sider>
      <Layout className="workspace-layout min-w-0">
        <Header className="app-header flex items-center justify-between">
          <Space size={12}>
            <Button
              type="text"
              aria-label={collapsed ? '展开菜单' : '收起菜单'}
              aria-expanded={!collapsed}
              className="collapse-btn"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            />
            <Typography.Text type="secondary">
              采购管理 <span className="breadcrumb-slash">/</span>{' '}
              <span className="breadcrumb-current">
                {currentRoute.breadcrumb}
              </span>
            </Typography.Text>
          </Space>
          <Space size={14}>
            <Tag className="header-data-tag" icon={currentRoute.badgeIcon}>
              {currentRoute.badge}
            </Tag>
            <span className="user-avatar grid place-items-center">ZH</span>
          </Space>
        </Header>
        <Content className="app-content">
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <Routes>
              {appRoutes.map(({ path, Component }) => (
                <Route key={path} path={path} element={<Component />} />
              ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
}

export function App() {
  return (
    <ConfigProvider locale={zhCN} theme={appTheme}>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </ConfigProvider>
  );
}
