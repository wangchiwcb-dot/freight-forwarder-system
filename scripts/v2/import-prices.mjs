import { parseArgs } from 'node:util';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const {values}=parseArgs({options:{manifest:{type:'string'},prices:{type:'string'}}});
if(!values.manifest || !values.prices) throw new Error('请传入 --manifest 原件清单路径 --prices 解析价格目录');
const runtime=resolve('dist-server/index.js');
try {await access(runtime);} catch {throw new Error('请先执行 pnpm v2:build 构建导入服务');}
const result=spawnSync(process.execPath,[runtime],{stdio:'inherit',env:{...process.env,
  V2_IMPORT_ONLY:'true',V2_IMPORT_MANIFEST:resolve(values.manifest),V2_PRICE_DRAFTS:resolve(values.prices)}});
if(result.error) throw result.error;
process.exitCode=result.status??1;
