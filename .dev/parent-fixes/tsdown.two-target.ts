// tsdown.config.ts — DUA-TARGET VERSI (parent-prepared takeover patch)
// Sumber pola: verbatim config yang kubaca 10:03 pra-insiden + target client
// dsh-mnemon root tsdown.config.ts (lazy-CJS). apply(): replace whole file.
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

/** Node half: ESM, deps external (host resolves them). */
const host: UserConfig = {
  name: 'dsh-cortex',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: true },
}

/** Browser half: lazy-CJS factory the DSH client module system registers. */
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
  deps: {
    neverBundle: [/^react(?:\/.*)?$/, /^@deepseek-ai\/dsh-client-[^/]+(?:\/.*)?$/],
  },
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

// GATE setelah apply: rm -rf lib && pnpm run build && head -c 80 lib/client.js
//   harus tampil: window.__ModuleLoader__.load({ id: "dsh-cortex", factory: (require) => {
// head lib/index.js tetap `import` ESM (target host).
// CATATAN: pra-insiden `clean: true` ada di target host; kubuang jadi false untuk
// build dua-target (clean kedua target bisa saling hapus artifact — pola mnemon
// memakai clean=false + outDir bersama). Kalau mnemon root ternyata clean:true di
// keduanya, salin persis dari sana saat takeover (baca file itu sebelum apply).
