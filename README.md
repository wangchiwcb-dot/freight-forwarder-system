# 中航环球渠道报价台

面向深圳中航环球内部采购的静态报价查询工具。第一阶段不依赖后端服务或数据库，Excel 报价表经过离线解析后生成仓库内的标准化 JSON，前端只读取静态部署产物中的数据。

## 本地启动

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm preview
```

构建结果在 `dist/`，可部署到任意静态站点。应用使用 Hash Router，部署到子路径时不需要服务器重写规则。

## 数据架构

- `public/data/catalog.json`：数据版本、文件清单、按国家拆分的 JSON 分片索引和覆盖统计。
- `public/data/quotes-*.json`：标准化报价记录，包含代理、渠道、国家、货品适用性、重量/体积阶梯、计费规则、日期、来源单元格和待核提示。
- `public/data/rules-*.json`：从原报价提取的附加费、限制和原文备注。前端详情抽屉会显示这些规则，但不会把未确认费用当成 0。
- `public/data/coverage.json`：文件级解析覆盖和警告，页面的“数据源”弹窗可查看。

前端的 `src/domain/search.ts` 只计算记录中明确声明的基准运费。同一票货的 KG 与 CBM 渠道可按同币种基准运费比较；单价排序按币种、计费单位分组。首续重缺少完整进位规则时不估算，不同币种不直接混排为最低价。稳定性目前只展示人工评价状态，未知不会自动评分。

中航部分普船按方结算使用 `max(体积, 实重 / 500, 最低体积)`，仅在该渠道原表明确给出密度换算时采用；义乌最低 1 CBM、特价渠道最低 5 CBM 单独保存。其它按方渠道不继承这些条件。详情保留赔付、限制和附加费用原文。

代码按后台系统模块划分：`src/app` 负责布局与路由，`src/features/quotes` 负责搜索及详情，`src/domain` 负责业务类型和比价规则，`src/data` 负责版本化 JSON 读取。未来接后端时可替换数据访问层。

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

这是内部采购成本查询工具，不是面向客户的销售报价系统。当前未配置远程仓库地址，尚未推送；也没有登录或后端接口。静态站点能够读取到的 JSON 也能被访问者下载，因此成本数据只应部署在受控的内部环境。
