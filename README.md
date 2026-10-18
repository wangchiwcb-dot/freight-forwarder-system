# 中航环球渠道报价台

面向深圳中航环球内部采购的报价查询工具。页面通过 Cloudflare Worker 接口读取 D1 数据库，支持分页检索、基准运费比较、来源证据、税费与货品条件、历史报价查看。

2026-10-18 接入已核对的数据库与第二轮解析修正结果。本期只提供查询能力，不含上传页、登录页或数据写入接口。见 [接口文档](docs/api.md) 和 [D1 数据库说明](docs/d1-database.md)。

## 本地启动

```bash
pnpm install
pnpm build
pnpm db:migrate:local
pnpm dev:api
# 另一个终端启动前端，/api 自动代理至本地 Worker
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm preview
```

首次本地迁移只创建空库，需导入已核对的数据备份；不要将生产导入脚本重复应用到云端。接口测试使用独立 SQLite 内存库，不改写生产数据。

构建结果在 `dist/`，Worker 入口是 `worker/index.ts`。应用使用 Hash Router；纯静态托管必须在构建时设置 `VITE_API_BASE_URL`。`pnpm preview` 仅预览静态产物，不启动 API。

## GitHub Pages 发布

网站地址：https://wangchiwcb-dot.github.io/freight-forwarder-system/

仓库 `Settings → Pages → Build and deployment → Source` 选择 **GitHub Actions**。推送到 `main` 后，`.github/workflows/ci.yml` 会依次校验报价数据、运行测试、执行 Vite 构建，并将 `dist/` 上传发布。所有检查通过后才更新网站；其他分支和 Pull Request 只执行检查，不发布。也可以在 Actions 中手动运行该工作流。

不要使用 `Deploy from a branch` 发布源码根目录或 `/docs`。GitHub Actions 构建时已设置正式 Worker 的 API 地址；Worker 和发布快照资源只为现有 GitHub Pages 来源返回 CORS 响应头。报价更新必须经过数据库核对与批次发布，并重新生成对应的备用快照。

## Cloudflare Workers 发布

正式地址：https://freight-forwarder-system.wangchi-wcb.workers.dev/

`wrangler.jsonc` 配置 Worker、D1 绑定和静态资源托管。`/api` 与 `/api/*` 总是先进入 Worker，其余请求由静态资源服务处理。

Cloudflare 的 Git 构建设置：

- 生产分支：`main`
- 根目录：`/`
- 构建命令：`pnpm build`
- 部署命令：`npx wrangler deploy`

推送到 `main` 后自动构建并发布。Wrangler 的自定义构建步骤执行 `pnpm check`，数据核对、数据库与接口类型检查、自动测试失败时禁止上传新版本。也可运行 `pnpm deploy` 手动构建并发布。未知 API 返回 JSON 404，缺失静态文件保持 404。

如果部署日志出现自动配置 Vite、安装 Wrangler，随后报 `ERR_PNPM_IGNORED_BUILDS: workerd`，应检查该次构建是否包含 `wrangler.jsonc`，以及根目录是否正确。已有配置会让 Wrangler 直接上传构建产物，避免在部署阶段自动改造项目。不要通过关闭 pnpm 的依赖脚本检查来绕过该错误。

## 数据架构

- `public/data/catalog.json`：数据版本、文件清单、按国家拆分的 JSON 分片索引和覆盖统计。
- `public/data/quotes-*.json`：标准化报价记录，包含代理、渠道、国家、货品适用性、重量/体积阶梯、计费规则、日期、来源单元格和待核提示。
- `public/data/rules-*.json`：从原报价提取的附加费、限制和原文备注。前端详情抽屉会显示这些规则，但不会把未确认费用当成 0。
- `public/data/coverage.json`：文件级解析覆盖和警告，页面的“数据源”弹窗可查看。

`public/data` 仍保留用于离线解析与核对，页面不再读取这些 JSON。`worker/search.ts` 在数据库中筛选和全量排序，仅读取当前页详情；共享的 `src/domain/search.ts` 再用十进制计算核对本页基准运费。同一票货的 KG 与 CBM 渠道可按同币种比较；单价排序按币种、计费单位分组。首续重缺少完整进位规则时不估算，未知货品能力及条件承运保留为待核候选，不同币种不直接混排为最低价。稳定性目前只展示人工评价状态。

D1 免费额度按扫描的行数累计，不是按返回条数或请求次数计算。耗尽后实时接口返回 `D1_READ_QUOTA_EXCEEDED` 和恢复时间，健康检查也会如实报错。额度在北京时间每日 08:00 重置。页面此时使用 `public/published` 中与云端核对一致的发布快照，明确展示快照版本和核对时间；搜索、翻页、详情、来源和历史仍可使用，快照后的数据变化待实时服务恢复后读取。刷新页面或点击刷新可重新尝试实时服务。不会自动开通付费计划。

备用快照由 `pnpm snapshot:build` 从本地已核对的只读数据库生成，生成前校验 `.local/d1-refinement/sync-completion.json` 的数据库哈希和零差异记录。只导出已发布报价，不上传数据库文件、原始导入记录或本地路径。生成产物随代码提交；CI 校验所有快照分片，不需要私有数据库。数据变更后必须重新核对、导出、测试和部署；不要手工修改版本目录中的文件。详见 [缓存与故障降级](docs/api.md#缓存与故障降级)。

中航部分普船按方结算使用 `max(体积, 实重 / 500, 最低体积)`，仅在该渠道原表明确给出密度换算时采用；义乌最低 1 CBM、特价渠道最低 5 CBM 单独保存。其它按方渠道不继承这些条件。详情保留赔付、限制和附加费用原文。

`src/app` 负责布局与路由，`src/features/quotes` 负责搜索及详情，`src/domain` 负责业务类型和比价规则，`src/data/api.ts` 负责接口访问与响应验证，`worker` 负责查询、分页和错误处理。

## 更新 Excel 报价

Excel 原件存放在仓库外的报价目录，不提交到 Git。离线解析需要 Python 及 `scripts/requirements.txt` 中的依赖。更新时先抽取工作表，再标准化并校验：

```bash
python -m pip install -r scripts/requirements.txt
python scripts/extract_workbooks.py --root "D:\Wants\中航环球\报价表\2026.10.07" --output "analysis/latest-extract.json"
pnpm data:normalize
pnpm data:validate
pnpm test
pnpm build
```

更新时把 `--root` 改为本次报价目录。`data:normalize` 默认读取 `analysis/latest-extract.json`。解析后检查 `catalog.json`、`coverage.json` 与对应国家分片的差异，再运行 `pnpm build`。保留 Git 版本即可回滚数据。原表中复杂附表、币种、赔付、最低计费和货品限制仍需在详情中人工确认；同一目的地也应按深圳、青岛等交仓地分别比较。

## 当前边界

当前 23 份报价表均保留来源和解析覆盖记录；首版只对可识别区块自动提取，并非每一格价格和每一条费用规则都能完整计算。复杂邮编附表、颜色标记限制和未确认规则不支持完整自动计价。

这是内部采购成本查询工具，不是面向客户的销售报价系统。本期按要求不做登录，公开站点的查询接口可被访问；接口仅返回已发布报价与业务来源证据，不返回本地文件路径、用户信息或审计内容，也不提供任何写入能力。CORS 不是访问认证。
