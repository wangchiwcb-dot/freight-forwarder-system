# 报价查询 API v1

基础路径 `/api`。Cloudflare 站点同源访问；GitHub Pages 使用构建变量 `VITE_API_BASE_URL` 指向正式 Worker。所有业务请求只读；SQL 参数绑定，浏览器 API 响应为 `no-store`，服务器缓存部分成功查询，不返回内部 SQL、原始导入 JSON 或本地文件路径。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 数据库连接检查 |
| GET | `/catalog?snapshotId=…` | 资料集、代理、覆盖统计和来源清单 |
| GET | `/sources?snapshotId=…` | 所选资料集的文件覆盖与警告 |
| POST | `/quotes/search` | 服务器筛选、计价、全量排序和分页 |
| GET | `/quotes/{id}` | 价格阶梯、税费、货品依据、费用与原表定位 |
| GET | `/quotes/{id}/history?page=1&pageSize=15` | 同业务条件历史报价，包含各档价格 |

默认资料集为 `source_kind=published_json` 的已发布网站报价，经数据库语义修正后展示。用户可切换其他已发布历史资料集。资料集目录日期、报价日期、生效时间、导入时间分开处理；不按最新导入时间选择“当前价”。历史身份仍为暂定时，保留同条件多来源，不自动去重覆盖。

## 检索示例

```json
{
  "criteria": {
    "country": "US",
    "mode": "all",
    "delivery": "all",
    "origin": "",
    "destination": "ONT8",
    "cargo": "general",
    "cargoShape": "all",
    "actualKg": 300,
    "volumeCbm": 1,
    "pieces": 10,
    "providerId": "",
    "onlyOwn": false,
    "includePending": true,
    "sort": "cost",
    "asOf": "2026-10-18"
  },
  "page": 1,
  "pageSize": 15
}
```

可增加 `snapshotId`，值取自目录的 `snapshots[].id`。重量、体积、件数不用时传 `null`；件数必须为正整数。字符串按枚举和长度校验；日期必须为有效的 `YYYY-MM-DD`；页大小 1–100，页码 1–100000。请求体最多 16 KiB，要求 `application/json`，重复查询参数与未知字段会被拒绝。

响应包含 `items`、`total`、`computedCount`、`pendingCount`、`page`、`pageSize`、`snapshotId`。数量与排序针对全部匹配记录，不能将单页价格当作全量最低价。空页返回空数组，保留完整总数。`eligible` 只表示结构化条件匹配，不代表完整到仓价或承运承诺。

报价 ID 是数据库版本 ID。每条结果携带 `quote`、命中 `tier`、`estimatedCost`、`chargeableQuantity`、`estimateLabel`、`warnings` 和 `eligible`。金额保留最多六位小数，显示层保留两位。固定费单位未确认、分区未匹配或币种不一致时，不自动估算；其它附加费仅展示证据，不当作零。未知或有条件的货品能力只作为待核候选，明确拒收的货品排除。未验证的仓码不自动认定为 Amazon。

`asOf` 按中国日期使用，今天按当前时刻判断，其他日期按该日末判断；文件名日期不伪装成明确生效日期。到达 `valid_to` 即失效。未发布、归档、撤销批次不进入查询、详情、历史或来源接口。

## 错误与权限

统一格式：`{"error":{"code":"VALIDATION_ERROR","message":"请求参数无效","requestId":"…","details":[…]}}`。

- 400：参数或 JSON 无效；413：请求体过大；415：内容类型错误。
- 404：接口、资料集或已发布报价不存在；405：方法不支持。
- 503：数据库不可用或计算校验失败。服务器记录请求 ID 与诊断，响应不透出内部 SQL。
- 503 / `D1_READ_QUOTA_EXCEEDED`：D1 当天免费读行额度耗尽，响应含 `retryAt`（UTC）和 `Retry-After`（秒），北京时间次日 08:00 重置。`/health` 读取真实业务表，避免 `SELECT 1` 在额度耗尽时误报健康。

本期没有用户认证，也没有写入接口。只为现有 GitHub Pages 域名返回跨域许可；这不构成数据访问控制。后续写入能力必须单独建立身份与权限校验。

## 缓存与故障降级

目录、来源共用 300 秒服务器缓存，详情和历史缓存 300 秒。固定查询日期的搜索缓存 15 秒；查询今天时按当前时刻判断生效/失效，不缓存搜索结果，避免跨时间边界复用。数据更正或撤销的最长缓存延迟为上述 TTL。`X-Data-Cache` 标明命中与否。缓存服务故障不影响健康数据库请求；失败响应不当作成功数据缓存。

数据库返回明确读行额度错误后，同一运行实例和边缘缓存记住该状态直到 UTC 零点，避免反复撞库。目录与来源可从经验证的静态发布快照返回 200，并附 `provenance`（source、version、verifiedAt、message）及 `X-Data-Source: published-snapshot`。实时搜索、详情和历史在无成功缓存时仍返回明确的 503；客户端不能将其误解为实时数据库恢复。

页面仅在该明确错误或目录快照标识出现时切换到已核对快照，使用共享十进制计算器在浏览器中筛选、排序和分页，按国家加载分片并复用。普通网络故障、参数错误和未知服务器错误不自动降级。页面提示快照核对时间和数据可能滞后；刷新会重新检查实时目录。

`public/published/manifest.json` 不缓存，哈希版本目录内的文件不可变缓存。导出流程为 `pnpm snapshot:build`：必须有本地规范数据库和云端核对通过且零差异的记录，核对数据库 SHA-256 后导出已发布记录。每次数据更新必须重新核对、导出并提交新快照，生产构建只使用提交的产物，不连接私有数据源。旧的 `public/data` 不参与降级。

已将费用关联改为利用 `idx_charges_version`，查询条件避免无条件 OR。本地查询计划可用 `scripts/inspect-search-plan.ts` 只读检查；本地耗时不能替代 D1 实际读行量。服务器以 `d1_usage` 事件记录 requestId、path、statements、rowsRead、durationMs，供额度恢复后评估读行预算；不会自动升级付费服务。

## 验证与发布

```bash
pnpm check
pnpm build
pnpm test:api:smoke https://freight-forwarder-system-preview.wangchi-wcb.workers.dev
# 明确预期当天读行额度耗尽时，单独验收降级模式（不是实时接口通过）：
pnpm test:api:smoke https://freight-forwarder-system-preview.wangchi-wcb.workers.dev --expect-quota
# 环境变量 E2E_BASE_URL 指向待验收站点，再运行：
pnpm test:e2e
pnpm deploy
pnpm test:api:smoke https://freight-forwarder-system.wangchi-wcb.workers.dev
```

单元与接口集成测试用真实 SQLite、生产迁移和独立测试数据，覆盖错误处理、隔离、边界、分页与计价。若本地存在 `.local/d1-import/freight-quotes.sqlite`，额外只读加载已验证数据库，对照全部报价计算、排序、数量和六期资料集统计；CI 没有私有数据库时显式跳过该验收项。

Playwright 验证真实站点的搜索、翻页、详情、历史、数据源、资料集切换、手机布局和空结果。Windows 默认使用已安装 Chrome；CI 可安装 Chromium。网络需要代理时只为验证进程设置 `API_TEST_PROXY` 或 `E2E_PROXY`，不修改系统设置。报告和截图在 `.local/api-acceptance/`，不提交采购内容。

本期没有新数据库迁移或数据修改。回滚应用时可部署前一 Worker 版本，数据库历史记录保留。生产、预览共用现有 D1，只读查询不更改批次状态。
