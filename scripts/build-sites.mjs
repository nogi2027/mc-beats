import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The app is a client-only Vite SPA. Sites runs a Cloudflare worker entry, so
// keep the normal Vite output for local preview and mirror it into the worker's
// static asset directory.
const dist = resolve('dist');
const client = resolve(dist, 'client');
const server = resolve(dist, 'server');

rmSync(client, { recursive: true, force: true });
mkdirSync(client, { recursive: true });

for (const name of readdirSync(dist)) {
  if (name === 'client' || name === 'server') continue;
  cpSync(resolve(dist, name), resolve(client, name), { recursive: true });
}

mkdirSync(server, { recursive: true });
writeFileSync(
  resolve(server, 'index.js'),
  `export default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  },\n};\n`,
);
writeFileSync(
  resolve(server, 'wrangler.json'),
  `${JSON.stringify(
    {
      main: 'index.js',
      compatibility_date: '2025-05-15',
      assets: {
        directory: '../client',
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
      },
    },
    null,
    2,
  )}\n`,
);
