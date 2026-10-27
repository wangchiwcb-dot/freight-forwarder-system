# 前端主题与扩展约定

## 视觉方向

参考 [Hunting 后台管理系统（格 子）](https://www.behance.net/gallery/142154333/Hunting-) 的白色导航、浅灰工作区、蓝色重点、轻边框与低阴影卡片。界面继续服务于多渠道成本比价和规则维护，保留中航环球品牌、业务口径与来源证据；参考作品中的图片和品牌素材不进入产品。

## 样式体系

- `src/theme/tokens.ts` 是唯一的基础设计变量来源，定义语义颜色、圆角、阴影和字体。`main.tsx` 在 React 渲染前将变量安装到 `document.documentElement`，因此弹窗、抽屉、下拉菜单和提示框也能继承。
- `src/theme/antd.ts` 将变量映射到 Ant Design 的公共 token 和组件配置。调整按钮、表格、菜单等组件优先使用这里的配置。
- `src/styles/utilities.css` 接入 Tailwind CSS 4 的 Vite 构建插件，仅导入 theme 和 utilities，**不导入 Preflight**，避免覆盖 Ant Design 的组件基础样式。通用布局使用 `flex`、`grid`、`gap-*`、`min-w-0` 等工具类；品牌颜色使用 `text-brand`、`bg-brand-soft` 等语义工具类。
- `src/styles/global.css` 仅保留基础规则与共享页头；`shell.css` 负责应用外壳。多渠道成本比价页的 `quotes-v2.css` 负责表格、抽屉、规则编辑器和移动布局。
- 页面 CSS 使用 `var(--color-primary)`、`var(--color-surface)` 等语义变量，不新增散落的色值。Ant Design 组件样式优先用 ConfigProvider 配置，避免大量高优先级选择器；业务 CSS 负责布局和必要的局部适配。
- 危险、警告和成功状态保留语义颜色，不随品牌蓝色一起替换。

当前交付一个浅色主题。没有增加主题切换器或持久化偏好；需要新主题时先扩展 token，再同时验证页面和浮层。

## 路由与状态

`src/app/routes.tsx` 集中声明路径、导航名称、图标、页面组件、面包屑和资料标签。首页为多渠道成本比价，使用懒加载和 React Router 的 HashRouter。

TanStack Query 管理接口的加载、缓存、取消和错误状态。表单输入、弹窗开关及单页展示状态使用 React 自身状态。当前不存在需要 Redux 或 Jotai 解决的跨页面客户端状态，因此不额外引入第二套状态管理。将来出现确切的共享状态需求时再选择合适的库，不复制 Query 中已有的服务端数据。

## 性能

多渠道成本比价页按需读取价格草稿、规则和比价快照；首次进入页面不会预载原表详情。Ant Design 和 Tailwind 只参与页面展示与构建，不引入额外的图表运行时。

## 验证

运行 `pnpm check`、`pnpm build`；用指向 V2 测试服务的 `E2E_BASE_URL` 运行 `pnpm test:e2e`。浏览器用例覆盖成本计算、分页、来源详情、规则维护、入仓复算和移动布局。测试会保存比价快照，应使用本地测试库；`E2E_V2_WRITE=1` 另启用规则草稿保存测试。
