# 中航环球多渠道成本比价

这是深圳中航环球内部采购使用的多渠道运输成本比价系统。当前前端只保留“多渠道成本比价”页面，页面包含报价计算、原表价格查询和渠道规则维护。

## 项目结构

- `src/features/quotes-v2/`：多渠道成本比价页面及规则维护界面。
- `src/domain/v2/`：计价、条件判断、比价排序和接口契约。
- `server/v2/`：Node.js/Fastify API、PostgreSQL 连接、导入和版本发布逻辑。
- `server/v2/migrations/`：`quotation_v2` PostgreSQL Schema 的迁移文件。
- `deploy/v2/`：阿里云服务器上的 Docker Compose、Nginx 和运行配置。

原始 Excel/PDF 原件保存在部署目录的 `source-data`，数据库保存原件摘要、解析草稿、价格阶梯、规则、来源证据和比价快照。

## 本地开发

先启动 V2 API：

```powershell
$env:V2_IMPORT_MANIFEST='.local/v2/intake/manifest.json'
$env:V2_PRICE_DRAFTS='.local/v2/normalized'
$env:V2_PREPARE_OWN_US='true'
pnpm v2:dev
```

另开终端启动前端：

```powershell
pnpm dev --port 5177
```

访问 `http://127.0.0.1:5177/#/`。本地未设置 `DATABASE_URL` 时，API 使用 `.local/v2/postgres` 中的 PGlite；生产环境必须设置 PostgreSQL 连接地址。

原件导入流程：

```powershell
python -X utf8 scripts/v2/intake.py --root '报价原件目录' --output .local/v2/intake
python scripts/extract_workbooks.py --root '报价原件目录' --output .local/v2/price-extract.json
node scripts/normalize-quotes.mjs .local/v2/price-extract.json .local/v2/normalized
pnpm v2:build
pnpm v2:import --manifest .local/v2/intake/manifest.json --prices .local/v2/normalized
```

新原表导入后先进入待生效区。在“原表价格查询 → 每周报价更新”中选择上一期、预览变化并确认生效日期，匹配的渠道才会按日期切换。没有新表的代理继续沿用旧价，历史报价与比价记录保留。原件归档目录需要长期保存，避免原表下载链接失效。详细操作见 [每周报价更新与规则维护](docs/quotation-v2-review-guide.md)。

## 检查与构建

```powershell
pnpm check
pnpm build
pnpm v2:build
```

`pnpm build` 构建前端，`pnpm v2:build` 构建 API 服务并复制数据库迁移文件。`pnpm v2:package` 会生成可部署的 V2 发布包。

## 阿里云部署

部署目标是阿里云香港服务器上的 PostgreSQL 17、V2 API 和 Nginx。数据库与 API 不映射公网端口，公网入口由 Nginx 转发到 `/api/v2`。

部署、备份、HTTPS 和版本更新说明见：

- [V2 部署说明](docs/quotation-v2-deployment.md)
- [服务器运行记录](docs/quotation-v2-server-operations.md)
- [HTTPS 配置说明](docs/quotation-v2-https.md)
- [规则维护指南](docs/quotation-v2-review-guide.md)

正式发布渠道、计费规则、服务范围和税费口径需要在规则维护中完成复核后再发布。草稿价格可以用于参考比价，但不代表完整结算成本。
