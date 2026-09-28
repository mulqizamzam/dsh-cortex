import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Two targets (parent takeover 2026-09-15, mirroring dsh-mnemon's root
 * tsdown.config.ts verbatim in the client mechanics):
 *   host   → lib/index.js  ESM (node; deps stay external — schemastery etc. resolve from node_modules)
 *   client → lib/client.js LAZY-CJS factory registered via window.__ModuleLoader__.load
 *          — the ONLY shape the DSH client-module system accepts; a plain ESM
 *          browser file loads without registering and the panel never mounts.
 * The loader-entry `name` in cordis.patch.yml MUST equal the banner id below.
 */
const host: UserConfig = {
  name: 'dsh-cortex',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: { neverBundle: true },
}

const CLIENT_EXTERNALS = [
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
  /^@deepseek-ai\/dsh-client-[^/]+(?:\/.*)?$/,
]

const client: UserConfig = {
  name: 'dsh-cortex/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: { neverBundle: CLIENT_EXTERNALS },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "dsh-cortex", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
export { PROJECT_ROOT, resolvePath }
