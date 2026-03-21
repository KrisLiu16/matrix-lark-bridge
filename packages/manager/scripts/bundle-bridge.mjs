/**
 * Bundle bridge into a SINGLE self-contained file using esbuild.
 * Zero external dependencies — everything inlined, no node_modules needed.
 */
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const managerRoot = join(__dirname, '..');
const monoRoot = join(managerRoot, '../..');
const bridgeSrc = join(monoRoot, 'packages/bridge');
const out = join(managerRoot, 'bridge-bundle');

// Clean
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(join(out, 'dist'), { recursive: true });

// Use esbuild JS API (avoids shell escaping issues with banner)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require(join(monoRoot, 'packages/bridge/node_modules/esbuild'));

console.log('bundling bridge with esbuild (single file, zero deps)...');
await esbuild.build({
  entryPoints: [join(bridgeSrc, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'dist/index.mjs'),
  sourcemap: true,
  external: ['node:*'],
  // CJS shim: some deps use require() / __dirname / __filename
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameFn } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameFn(__filename);",
    ].join('\n'),
  },
  logLevel: 'warning',
});

// Copy skills (read at runtime via relative path)
if (existsSync(join(bridgeSrc, 'dist/skills'))) {
  cpSync(join(bridgeSrc, 'dist/skills'), join(out, 'dist/skills'), { recursive: true });
}

// Minimal package.json
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: '@mlb/bridge',
  version: '0.1.1',
  type: 'module',
  main: 'dist/index.mjs',
}, null, 2));

console.log('bridge-bundle ready:', out);

// --- Bundle deepforge ---
const dfSrc = join(monoRoot, 'packages/deepforge');
const dfOut = join(managerRoot, 'deepforge-bundle');

if (existsSync(dfOut)) rmSync(dfOut, { recursive: true });
mkdirSync(join(dfOut, 'dist'), { recursive: true });

console.log('bundling deepforge with esbuild (single file, zero deps)...');
await esbuild.build({
  entryPoints: [join(dfSrc, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(dfOut, 'dist/index.mjs'),
  sourcemap: true,
  external: ['node:*'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameFn } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameFn(__filename);",
    ].join('\n'),
  },
  logLevel: 'warning',
});

writeFileSync(join(dfOut, 'package.json'), JSON.stringify({
  name: '@mlb/deepforge',
  version: '0.8.0',
  type: 'module',
  main: 'dist/index.mjs',
}, null, 2));

console.log('deepforge-bundle ready:', dfOut);
