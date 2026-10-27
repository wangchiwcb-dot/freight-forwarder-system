import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist-server/migrations', { recursive: true });
await cp('server/v2/migrations', 'dist-server/migrations', { recursive: true });
