# 前端主题与扩展约定

## 视觉方向

参考 [Hunting 后台管理系统（格 子）](https://www.behance.net/gallery/142154333/Hunting-) 的白色导航、浅灰工作区、蓝色重点、轻边框与低阴影卡片。界面继续服务于报价查询和时效分析，保留中航环球品牌、业务口径与来源证据；参考作品中的图片和品牌素材不进入产品。

## 样式体系

- `src/theme/tokens.ts` 是唯一的基础设计变量来源，定义语义颜色、圆角、阴影和字体。`main.tsx` 在 React 渲染前将变量安装到 `document.documentElement`，因此弹窗、抽屉、下拉菜单和提示框也能继承。
- `src/theme/antd.ts` 将变量映射到 Ant Design 的公共 token 和组件配置。调整按钮、表格、菜单等组件优先使用这里的配置。
- `src/styles/utilities.css` 接入 Tailwind CSS 4 的 Vite 构建插件，仅导入 theme 和 utilities，**不导入 Preflight**，避免覆盖 Ant Design 的组件基础样式。通用布局使用 `flex`、`grid`、`gap-*`、`min-w-0` 等工具类；品牌颜色使用 `text-brand`、`bg-brand-soft` 等语义工具类。
- `src/styles/global.css` 仅保留基础规则与共享页头；`shell.css` 负责应用外壳。报价页的 `quotes.css` 和时效页的 `transit.css` 随各自路由加载，容纳表格、报告和打印等业务样式。
- 页面 CSS 使用 `var(--color-primary)`、`var(--color-surface)` 等语义变量，不新增散落的色值。Ant Design 组件样式优先用 ConfigProvider 配置，避免大量高优先级选择器；业务 CSS 负责布局和必要的局部适配。
- 危险、警告和成功状态保留语义颜色，不随品牌蓝色一起替换。主次时效曲线同时用实线、虚线区分，文案也按线型描述。

当前交付一个浅色主题。没有增加主题切换器或持久化偏好；需要新主题时先扩展 token，再同时验证页面、图表、浮层和报告。

## 路由与状态

`src/app/routes.tsx` 集中声明路径、导航名称、图标、页面组件、面包屑和资料标签。新增页面在这里注册，使用懒加载。继续使用 React Router 的 HashRouter，以兼容现有静态部署。时效筛选仍放在 URL 中，便于刷新和分享。

TanStack Query 管理接口和静态数据集的加载、缓存、取消和错误状态。表单输入、弹窗开关及单页展示状态使用 React 自身状态。当前不存在需要 Redux 或 Jotai 解决的跨页面客户端状态，因此不额外引入第二套状态管理。将来出现确切的共享状态需求时再选择合适的库，不复制 Query 中已有的服务端数据。

## 图表与性能

`src/theme/charts.ts` 只提供配色、字体和坐标轴的基础主题。业务图表直接从 `@ant-design/charts` 导入 `Line`、`Bar`、`Heatmap` 标准组件，库负责布局、Canvas、坐标轴、图例、原生 tooltip 和事件。不使用 `Base` 或 `children` 手工组合图形，也不另外用 HTML/CSS 绘制图例。`src/features/transit/chartData.ts` 负责转换成库需要的长表数据：期间/渠道、指标、天数。缺样本用 null 保留，由原生 Line 断线。

图表启用 `autoFit`。当前 G2 版本只监听窗口变化，不能单独覆盖侧栏折叠引起的面板变化，所以 `useChartFrame` 用 ResizeObserver 和 requestAnimationFrame 合并通知，然后调用原生 `forceFit()`。不把每个像素的宽度送入 React，也不以宽度作为 `key` 重建 Canvas；仅跨越 600px 标签断点时更新标签配置。

原生 tooltip 保留一个边界适配层，处理滚动和视口四周的裁切，不自绘 tooltip 内容。报告 PNG 的背景与 CSS、Canvas 使用同一套颜色；打印样式仍只输出客户报告。

当前使用 `@ant-design/charts@2.6.7`。聚合包附带未使用的关系图组件，其 Graphin 依赖声明 React 18 peer，会在 React 19 项目中产生安装提示。当前页面只使用绘图组件；生产产物会剔除未使用的关系图代码，浏览器回归覆盖实际运行的图表，不通过忽略或改写 peer 声明掩盖此提示。

Ant Design 和 AntV 是当前最大的构建块。报价首页不会预载时效数据和图表代码；时效首页也不会预载报价页面。Tailwind 仅参与构建，不增加浏览器运行时。

## 验证

运行 `pnpm check`、`pnpm build`；用指向测试服务的 `E2E_BASE_URL` 运行 `pnpm test:e2e`。浏览器用例覆盖报价查询、分页、详情、来源、时效筛选、日历窗口、图表钻取、tooltip 边界、PNG 导出、打印、路由历史，以及 320–1440px 和侧栏折叠期间 Canvas 实例复用。

本次本地浏览器验收使用仓库内已核对的发布快照，通过本地 API 额度响应触发既有备用读取路径；不写入或部署线上数据库。
