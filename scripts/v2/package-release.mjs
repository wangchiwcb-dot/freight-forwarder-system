import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const outputRoot = resolve('.local/v2/packages');
const applicationOnly = process.argv.includes('--application-only');
const releaseName = `freight-quotes-v2-${applicationOnly ? 'update-' : ''}${new Date().toISOString().replace(/[-:]/g, '').slice(0,15)}`;
const release = resolve(outputRoot, releaseName);
await mkdir(release, { recursive: true });
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Release command failed (${result.status})`);
};
run(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', resolve(release, 'dist')],
  { env: process.env });
const releaseDist = resolve(release, 'dist');
// Precompressed assets have a fixed Content-Length and survive slow public links
// better than a long streamed/chunked gzip response.
for(const asset of await readdir(resolve(releaseDist,'assets'))) {
  if(/\.(js|css)$/.test(asset)) await writeFile(resolve(releaseDist,'assets',asset+'.gz'),gzipSync(await readFile(resolve(releaseDist,'assets',asset)),{level:9}));
}
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(name, resolve(release, name));
await writeFile(resolve(release, '.dockerignore'), 'node_modules\n.git\n.env\ndeploy/v2/.env\ndeploy/v2/source-data\ndeploy/v2/backups\n*.log\n');
await cp('dist-server', resolve(release, 'dist-server'), { recursive: true });
await mkdir(resolve(release, 'deploy/v2'), { recursive: true });
for (const name of ['Dockerfile.runtime', 'nginx.conf', 'nginx.https.conf', 'compose.https.yaml', 'reload-https.sh', '.env.example', 'start.sh']) {
  const value = await readFile(`deploy/v2/${name}`, 'utf8');
  await writeFile(resolve(release, `deploy/v2/${name}`), value.replace(/\r\n/g, '\n'));
}
const compose = (await readFile('deploy/v2/compose.yaml', 'utf8')).replaceAll('deploy/v2/Dockerfile', 'deploy/v2/Dockerfile.runtime');
await writeFile(resolve(release, 'deploy/v2/compose.yaml'), compose.replace(/\r\n/g, '\n'));
if (!applicationOnly) {
  await cp('.local/v2/intake', resolve(release, 'deploy/v2/source-data'), { recursive: true });
  await cp('.local/v2/normalized', resolve(release, 'deploy/v2/source-data/normalized'), { recursive: true });
}
await cp('docs/quotation-v2-deployment.md', resolve(release, '部署说明.md'));
await cp('docs/quotation-v2-server-operations.md', resolve(release, 'quotation-v2-server-operations.md'));
await cp('docs/quotation-v2-review-guide.md', resolve(release, 'quotation-v2-review-guide.md'));
await cp('docs/quotation-v2-https.md', resolve(release, 'quotation-v2-https.md'));
const manifest = JSON.parse(await readFile('.local/v2/intake/manifest.json', 'utf8'));
const catalog = JSON.parse(await readFile('.local/v2/normalized/catalog.json', 'utf8'));
await writeFile(resolve(release, 'release.json'), JSON.stringify({ createdAt: new Date().toISOString(),
  applicationOnly, requiresExistingSources: applicationOnly, engineVersion: 'quotation-v2/2026-10-27.1',
  authentication: 'none', originalFiles: manifest.files.length, priceDrafts: catalog.stats.quotes,
  livePublishedOffers: 0, exampleOffers: 0, preparedOwnUsDrafts: 12, priceDraftsRequireReview: true }, null, 2));
const archive = resolve(outputRoot, `${releaseName}.tar.gz`);
run('tar', ['-czf', archive, '-C', outputRoot, releaseName]);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${releaseName}.tar.gz\n`);
await writeFile(resolve(outputRoot, applicationOnly ? 'latest-update.json' : 'latest.json'), JSON.stringify({ release, archive, sha256: digest }, null, 2));
console.log(JSON.stringify({ release, archive, sha256: digest }));
