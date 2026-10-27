# 报价 V2 本地运行与香港部署

2026-10-26。本期按用户确认执行：海运、铁路、卡航、空运并列；所有价格为采购成本；使用人数不超过 5 人；暂不接入登录和权限管理。本地首版及部署包完成后，用户已授权连接阿里云服务器并部署。香港服务器的实际状态与访问方法见 [服务器部署记录](quotation-v2-server-operations.md)。

## 当前可以使用的功能

- 多张真实报价表按国家、运输方式、邮编／仓码和货品属性筛选，比较各渠道的单价、基础运费、已知附加费与参考费用。
- 可比较全部适用报价，或在原表价格查询中勾选最多 200 条报价进行比较；四种运输方式并列。
- 渠道规则优先；原表规则未补齐时明示参考假设和缺失参数，不把未知费用当作零。
- 计算全部候选后按同币种已知费用排序并分页，保存不可覆盖的结果快照，支持入仓复算。
- 移除案例验证功能及“报价原件”页签；原表仍可从价格或结果明细下载。
- 自有美国海派沿用已确认的 6000、整票体积进位 0.1 方、整票取大及 1 kg 进位；美森单件最低按每箱实重补足 12 kg 后合计，已确认混合货案例计费 42 kg。
- PostgreSQL 迁移、渠道版本、原表追溯和规则维护保留。正式发布仍需复核全部必要条件。

当前正式发布渠道数量为 0。最新 38 份原件（36 个 Excel 和 2 个 PDF）已归档；36 个 Excel 的初步解析形成 21,391 条价格草稿。草稿中的代理、主干运输方式、有效期和费用规则尚待核实，不能作为完整整票总价参加正式排名。大型附表在旧价格识别适配器中仍有抽样范围，完整原始单元格证据另行保留；PDF 目前提取文本，尚未转换为价格规则。

同币种、同交仓点、同服务与税费口径的完整结果才比较最低价。当前没有自动汇率换算；不同币种分组。复杂分段累进、跨单位附加费、全自动解析全部代理条款及正式报价替换仍需继续实现，不能把此次原件归档当作全量报价已经上线。

## 本地运行

### 前期验证记录（本次公网及比价升级见服务器部署记录）

- `pnpm check` 通过：169 项 TypeScript 自动测试；现有报价数据核验、29 项运输资料 Python 测试及各服务类型检查通过。
- 本地 5 项浏览器流程已分别通过，覆盖费用明细、拒收、入仓复算关联、来源草稿、真实价格搜索、规则保存与手机布局，以及无完整方案／无候选时的说明。
- 最低计费更新另有 1 项本地浏览器流程通过，实际输入两箱货物得到 42 kg，并检查规则维护中的计算顺序。
- 编译后的服务已用独立本地数据库启动，完成建表、示例写入、计算及历史快照读取。20 kg 的西班牙私人地址演示得到海运 470 元、卡航 590 元（演示材积系数 6000、逐箱取大、1 kg 进位）。
- 38 份当前原件和归档副本的 SHA-256 全部一致；接口返回 38 份来源、21,391 条待核价格草稿、4 个示例和 0 个正式发布方案。
- 随后已在香港服务器启动 Docker 容器及真实 PostgreSQL，完成示例计算、草稿数量和备份恢复验证，详见服务器部署记录。

安装项目依赖后，开两个终端：

```powershell
# 终端一：首次导入时设置以下路径。后续同版本导入会直接复用。
$env:V2_IMPORT_MANIFEST='.local/v2/intake/manifest.json'
$env:V2_PRICE_DRAFTS='.local/v2/normalized'
$env:V2_PREPARE_OWN_US='true'
pnpm v2:dev

# 终端二
pnpm dev --port 5177
```

打开 `http://127.0.0.1:5177/#/`。开发环境使用 PGlite 运行 PostgreSQL SQL，保存在 `.local/v2/postgres`，无需本机安装数据库服务。不要同时启动两个进程操作同一个 PGlite 数据目录。设置 `DATABASE_URL` 后，后端改用实际 PostgreSQL；生产环境必须设置该连接。

原件归档与价格提取流程：

```powershell
python -X utf8 scripts/v2/intake.py --root 'D:\Wants\中航环球\报价表\2026.10.21' --output .local/v2/intake
python -X utf8 scripts/extract_workbooks.py --root 'D:\Wants\中航环球\报价表\2026.10.21' --output .local/v2/price-extract.json
node scripts/normalize-quotes.mjs .local/v2/price-extract.json .local/v2/normalized
```

Python 需具备 openpyxl、xlrd 和 pypdf。本次使用已提供的工作区 Python 环境；程序只读原件，并按 SHA-256 保存归档副本。不要将 `.local` 的采购资料提交到公开仓库。

## 部署包

```powershell
pnpm v2:package
```

产物位于 `.local/v2/packages/`，包括 `tar.gz`、SHA-256 校验文件和解压后的目录。包内包含已构建前端、Node.js 服务、SQL 迁移、38 份原件及来源证据、价格草稿、运行用 Dockerfile、Compose、Nginx 配置和本说明。无服务器密码或 SSH 私钥。本机开发数据库和测试中的报价记录不进入部署包。

项目与部署包仅包含 V2 站点，首页直接进入多渠道成本比价，提供计算、原表价格查询和渠道规则维护。前端使用同源 `/api/v2` 服务，构建无需额外的页面版本开关。

## Ubuntu 24.04 安装

服务器配置按用户提供的阿里云香港轻量实例设计：2 核 CPU、4 GB 内存、50 GB 系统盘。已通过核对指纹的 SSH 连接确认 Ubuntu 24.04.2、约 3.4 GiB 可用系统内存总量及 49 GiB 根分区；控制台未直接操作。

将部署包上传服务器并解压。需要 Docker Engine、Docker Compose 插件和 openssl。基础镜像与依赖从各自软件仓库下载。

```bash
tar -xzf freight-quotes-v2-<版本>.tar.gz
cd freight-quotes-v2-<版本>
bash deploy/v2/start.sh
```

启动脚本首次生成独立数据库密码并写入 `deploy/v2/.env`，随后启动 PostgreSQL、API 和 Nginx。不会启动登录系统。按用户最新要求，网站默认开放 `0.0.0.0:80`（PUBLIC_HTTP_PORT），同时保留 `127.0.0.1:8080`（HTTP_PORT）维护入口。阿里云防火墙需允许 TCP 80。数据库和 API 不映射公网端口；系统不设登录。

首次启动创建数据库、导入来源与价格草稿；真实报价可进行参考比价，草稿不会自动发布；新环境不再播种示例。导入完成前接口可能尚未就绪。API 使用 5 个数据库连接；数据库容器内存上限 1 GB，API 768 MB，Nginx 128 MB。数据库不映射主机公开端口。

在部署目录查看状态和日志：

```bash
cd deploy/v2
docker compose ps
docker compose logs --tail=100 api
curl http://127.0.0.1:8080/api/v2/health
```

健康检查成功只说明数据库和服务可用，不说明全部代理规则已经复核或已验证真实服务器并发性能。本机未安装 Docker，容器运行和备份恢复已在香港服务器上实测。公网通过 TCP 80 访问；`HTTP_PORT=127.0.0.1:8080` 保留维护隧道，不影响公网入口。

## 备份与更新

PostgreSQL 数据保存在 Compose 命名卷，重建应用容器不会覆盖。原件在 `deploy/v2/source-data`，以只读方式提供给应用。

```bash
cd deploy/v2
mkdir -p backups
docker compose exec -T postgres pg_dump -U freight -d freight -Fc > "backups/freight-$(date +%Y%m%d-%H%M%S).dump"
```

备份需同步到服务器之外，并在独立数据库验证可恢复。更新前先备份；不要执行 `docker compose down -v`，该参数会删除数据卷。更新软件时保留 `.env`、数据库卷和 source-data。迁移按名称和文件摘要校验，已有迁移不可改写。

已有原件和价格库的服务器可使用小型应用更新包，避免重复上传全部采购资料：先执行 `pnpm v2:build`，再执行 `node scripts/v2/package-release.mjs --application-only`。产物记录在 `.local/v2/packages/latest-update.json`，只包含应用及配置，不能独立用于首次部署。复制旧发布目录到新的版本目录后覆盖应用包，保留旧目录用于回退，并继续使用原 Compose 项目名称、数据库命名卷、`.env` 和 `source-data`。

`V2_PREPARE_OWN_US=true` 会按已核对原件和用户确认口径建立未关联的自有美国海派草稿，重复启动不会再次建立同一原表记录的草稿，也不会自动发布。新增迁移为 `0005_review_workflow.sql`。

`0006_own_us_confirmed_minimum.sql` 对符合原始参数的首版自有美国海派草稿补充已确认的最低计费口径，并记录旧值。已发布版本、用户保存的新修订和历史试算快照不修改；后续新建草稿直接采用确认参数。单件最低与整票取大的组合需要明确 `minimumPieceApplication=actual_before_shipment_max`，没有确认此参数的其他渠道继续提示待核。

## 后续数据工作

### 每周新报价导入（2026-10-27）

数据库迁移 `0008_weekly_versions.sql` 新增报价期、原表价格适用期间和已发布渠道的版本衔接记录。迁移将现有来源保留为可用状态；以后导入的新来源先进入待生效区，不会直接替换线上价格。

每期使用独立目录保存归档、证据与标准化输出，例如：

```powershell
python -X utf8 scripts/v2/intake.py --root '本周报价目录' --output .local/v2/weeks/2026-10-28/intake
python -X utf8 scripts/extract_workbooks.py --root '本周报价目录' --output .local/v2/weeks/2026-10-28/extract.json
node scripts/normalize-quotes.mjs .local/v2/weeks/2026-10-28/extract.json .local/v2/weeks/2026-10-28/normalized
pnpm v2:build
pnpm v2:import --manifest .local/v2/weeks/2026-10-28/intake/manifest.json --prices .local/v2/weeks/2026-10-28/normalized
```

本地导入遵循 `DATABASE_URL` 或 `V2_DATA_DIR` 的数据库配置。不要在本地 API 正占用同一 PGlite 目录时另开导入进程；可先停止本地 API，导入后再启动。真实 PostgreSQL 可在服务运行时导入。

更新现有阿里云时，先将本期 `intake` 与 `normalized` 上传到当前部署的 `deploy/v2/source-data/weeks/2026-10-28/` 下，保留所有历史目录，再利用 API 容器已有的数据库连接执行：

```bash
cd /opt/freight-quotes/current/deploy/v2
sudo docker compose exec -T \
  -e V2_IMPORT_ONLY=true \
  -e V2_IMPORT_MANIFEST=/data/sources/weeks/2026-10-28/intake/manifest.json \
  -e V2_PRICE_DRAFTS=/data/sources/weeks/2026-10-28/normalized \
  api node dist-server/index.js
```

该命令导入后退出，不重启 API，也不自动确认报价生效或发布规则。随后在网页“每周报价更新”中预览和确认。相同来源与目录重复执行可复用导入；已经进入报价期的原表数据会冻结，不能通过重新解析覆盖历史。

渠道采用保守的业务字段匹配，不以文件名、单元格位置或单价作为渠道身份。同一表内无法唯一匹配的记录需要用户选择；代理未提供新表、或旧渠道没有匹配到新记录时继续保留旧价。规则继承后仍需复核，已发布历史内容和保存的快照不修改。

本地周更浏览器验收可用 `e2e/seed-weekly.ts`，仅允许向 `.local/v2/weekly-tests/` 内、由 `E2E_WEEKLY_DATA_DIR` 指定且 API 已停止的独立 PGlite 库写入验收记录；不得设置 `DATABASE_URL`。启动该库后设置 `E2E_WEEKLY_FIXTURES=1` 执行 `e2e/weekly-updates.spec.ts`。生产验收不启用此开关。

优先从自有渠道和高频同行确认稳定渠道身份、交仓点、服务及税费范围、主干方式、材积系数、进位规则和附加费。确认后的渠道保存为正式草稿，经发布校验后加入真实比价。

原始报价中“快递”“小包”等字样不能直接替代主干运输方式。旧解析器的推断只作为草稿提示；未确认前不会擅自归入海运或空运。真实报价日期由文件和原表核对，目录名 2026.10.21 不作为所有文件的统一生效日期。

`0007_comparison_runs.sql` 保存真实原表比价请求、参考参数、结果排名、来源和入仓复算关联，历史示例试算记录保留在原表。新比价使用 `/api/v2/comparisons`，结果按保存时的数据分页读取。

## 2026-10-27 HTTPS

现有香港服务器使用 https://47.82.68.65/，HTTP 自动跳转。已安装受信任 IP 证书及自动续期任务。HTTPS 配置随部署包提供，证书私钥只保存在服务器；新机器需先完成证书申请，再把 compose.https.yaml 激活为 compose.override.yaml。应用更新须保留现有覆盖文件及持久证书／验证目录。详见 quotation-v2-https.md。

2026-10-27 域名更新：主入口为 https://quote.omfreight.vip/。当前 nginx.https.conf 同时支持域名和原 IP，分别引用 freight-quotes-domain 与 freight-quotes-ip 两张证书；新服务器需要完成两张证书的签发才能启用该完整 HTTPS 配置。更新现有服务时保留 compose.override.yaml 与 /etc/letsencrypt，详情见 quotation-v2-https.md。
