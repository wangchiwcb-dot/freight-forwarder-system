# D1 报价历史库

数据库名称：`freight-quotes`；绑定名：`DB`；位置提示：APAC。配置在 `wrangler.jsonc`，迁移在 `migrations/`。

数据库保存历史报价及证据。2026-10-18 网页已接入 Worker 查询接口，仅提供已发布批次的检索、详情、来源与历史记录；不提供上传、登录或写入功能。接口范围及验证方式见 [接口文档](api.md)。

2026-10-17 首次迁移已完成：19 张业务表、21,342 个报价版本、52,090 个价格档位；35 个批次入库、1 个备份批次归档、1 个非报价批次排除。原始 Excel 的 51,028 个数值价格核对通过，发布后云端全部业务表与本地一致。完整验收报告保存在 `.local/d1-import/验收报告.md`。

2026-10-18 第二轮解析修正已完成云端同步，仍使用免费套餐。`0002_semantic_refinement.sql` 及增量补丁均执行成功；重新导出后，全部 21 张业务表（含状态和审计记录）与已验证的修正库逐表一致，差异为 0，外键检查通过。云端占用 261,476,352 字节。当前本地库 `.local/d1-import/freight-quotes.sqlite` 已更新为该版本，原库及原报告保存在该目录的 `before-refinement-20261018/`。修正报告和云端核对证据位于 `.local/d1-refinement/`；该目录的 `待同步说明.md` 已标记为完成，不应重复执行旧补丁。

## 数据模型

- 基础资料：`providers`、`channels`、`warehouses`。
- 报价：`quote_items`、`quote_versions`、`quote_tiers`、`quote_targets`、`quote_cargo_types`、`quote_rules`。
- 附加费：`quote_charge_rules`、`charge_rule_targets`。
- 来源及导入：`source_files`、`dataset_snapshots`、`import_batches`、`snapshot_batches`、`import_rows`、`import_issues`。
- 管理及复核：`app_users`、`audit_logs`、`review_tasks`、`review_task_quotes`。

一个报价项关联多个历史版本；仓库/邮编、阶梯价、货品条件、计费规则都关联具体版本。业务身份不依赖 Excel 文件名和行号。首次迁移的渠道身份标为 provisional；相同条件对应多个来源行时保留全部版本并标记复核。

`quote_versions` 与 `quote_tiers` 包含税费口径、关税/VAT 包含情况、税费处理方式及原文依据。按用户于 2026-10-17 确认的业务规则，未写不包税时默认包税；具体档位、对应列头和行备注优先于渠道与工作表名称。`tax_evidence_kind` 区分 `explicit`（原表明确）与 `business_default`（业务默认），保留规则版本，避免把默认规则误当成原表声明。

VAT 递延/PVA、自税、递延或自税可选独立保存在 `tax_settlement`，不作为全包税。这里 `vat_inclusion=excluded` 表示报价未代付 VAT，不表示免税；关税没有明确依据时仍为 unknown。货物属性保存 allowed / forbidden / conditional / unknown，不将“敏感货”自动扩展成可接纯电；读取对应行备注中的可接、拒收及单询条件。

金额以百万分之一币种单位存整数，同时保存原始十进制文本。邮编始终为文本，保留前导零。报价日期、生效时间、目录观察日期、导入时间分开保存，不用上传日期伪造历史生效日期。未明确的失效日期保持空值。

## 迁移边界

- 保留原有 19,319 条已发布记录，并导入本地日期目录中的历史报价。
- 原 Excel 不修改；按 SHA-256 去重，重复目录保留来源关联。原件暂保留本地，不自动上传 R2。
- 备份/加价前文件标为 archive_only；货箱明细只登记，排除出报价。
- 原表备注存于不可变规则内容中；同样的长备注只存一份，源报价可完整恢复。
- 原字段 fixedFee 的单位通过原表对应表头补齐；只有数字与源单元格一致、单位明确时才确认。存在分区子表头时同时保存适用分区，不将其中一列处理费当作全国统一费用。
- 历史仓码不自动认定为 Amazon；仓库平台和地址尚待独立核实。
- 大型附表仍可能只有抽样提取。表中保留覆盖报告，不能宣称原工作簿每个费用及邮编都已结构化。
- published 表示批次完整入库，不表示条款全部已核实。pricing_readiness 为 base_only/needs_review 等；尚无记录可据此宣称完整到仓总价。

## 本地重建及核对

要求 Node >=22.14、Python、现有 Excel 读取依赖，以及 `pnpm install`。

```powershell
pnpm history:extract --root "D:\Wants\中航环球\报价表"
pnpm db:build
pnpm db:verify
pnpm db:typecheck
pnpm test
pnpm build
```

`history:extract` 写入 `.local/history/`，不会替换 `public/data`。仅在文件哈希一致时复用旧提取；新增文件重新读取。`db:build` 可重复运行，按导入指纹去重，生成 `.local/d1-import/freight-quotes.sqlite` 和待导入 SQL。

核对分四层：

1. `verify-history.ts`：逐条恢复原始报价，核对价格、档位、计费规则、日期、目的地、货品映射、固定费和来源；检查外键与 SQLite 完整性。
2. `verify-workbooks.py`：独立读取真实 Excel，不把中间 JSON 当唯一证据；复核文件 SHA-256 和每个有数值价格的单元格。
3. `compare-d1.py`：下载 D1 的 SQL 导出，在本地重建影子库，对所有业务表逐行计算摘要，与已验证本地库比较。
4. `verify-refinement.py`：比较修正前后的不可变事实与价格，验证真实工作表中的包税、不包税、PVA、自税、每票费用及货品备注案例。

报告在 `.local/d1-import/`，包含采购信息，已被 Git 忽略。需要复核的业务条件在 `import_issues`，不能将待核项当成零费用或已确认承运能力。

## 解析修正与提示归并

`0002_semantic_refinement.sql` 新增 `review_tasks`、`review_task_quotes`，并为税费判断保存档位级证据。共 21 张业务表。原始 `import_rows.source_quote_json`、报价内容摘要、数值价格和来源坐标保持不变；解析修正不会伪装成代理发布的新报价版本。

旧的逐报价提示在 `import_issues` 保留处理记录，通过 `review_task_id` 追溯合并后的任务。实际待办读取 `open_review_tasks`，分为：

- `business`：缺少业务依据或渠道可用性需要确认。
- `parsing`：剩余费用、邮编分区、复杂附表等需要完善程序的内容。
- `reference`：未注明货品能力及仓库资料的补充维护，不阻止基础报价查看，也不自动赋予带电、带磁等能力。

相同文件内容、工作表与问题类型共享任务，报价通过关联表保留影响范围。报价生效日期按文件合并，仓库资料按国家归并后维护仓库字典。原始隐藏工作表保持原有报价状态，并按工作表提示可用性。

已有云端库应先备份，用数据库副本运行 `refine-history.ts`，验证后由 `export-refinement.py` 生成增量 SQL。先应用迁移，再执行补丁，最后导出云端与已核对副本逐表比较。此次修正材料保存在 `.local/d1-refinement/`。后续 `db:build` 会自动执行同一套语义修正规则；`db:refine` 默认处理该修正目录中的副本。

## 云端首次导入

仅在本地两份核对报告均通过后执行。不得跳过批次发布前回读核对。

```powershell
pnpm exec wrangler login
pnpm db:migrate:remote
pnpm exec wrangler d1 execute freight-quotes --remote --file .local/d1-import/import.sql --yes
pnpm exec wrangler d1 export freight-quotes --remote --output .local/d1-import/remote-staged.sql
python -X utf8 scripts/db/compare-d1.py --remote-sql .local/d1-import/remote-staged.sql --phase staged
pnpm exec wrangler d1 execute freight-quotes --remote --file .local/d1-import/publish.sql --yes
pnpm exec wrangler d1 export freight-quotes --remote --output .local/d1-import/remote-published.sql
python -X utf8 scripts/db/compare-d1.py --remote-sql .local/d1-import/remote-published.sql --phase published --output .local/d1-import/remote-published-verification.json
```

导入 SQL 将批次设为 staged；通过云端回读核对后才发布。数据库触发器阻止不完整批次、缺失来源行和有未解决错误的批次发布。

发布后再次回读，包含批次状态、发布时间及审计记录在内的全部业务表均须匹配本地已核对数据库。首次发布前、发布后的核对报告分别保存，避免覆盖证据。

这组命令面向首次迁移。后续前端上传应由带身份校验的 Worker 分块接收、校验、核对后发布，不能把后台管理凭证放进浏览器，也不能用最新上传日期直接选择当前价。

新增或修改解析映射时应更新迁移解析器版本，并再次执行核对。不要把历史解析修正伪装成代理发布的新价格。
