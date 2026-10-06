import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/**
 * Extension host bundle: runs in Node, `vscode` is provided by the host.
 * @type {import('esbuild').BuildOptions}
 */
const extensionConfig = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

/**
 * Webview bundle: runs in a browser context with no Node built-ins and no
 * `vscode` module. Importing `styles.css` here makes esbuild emit `dist/webview.css`.
 * @type {import('esbuild').BuildOptions}
 */
const webviewConfig = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [extensionConfig, webviewConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  // Markers consumed by the problem matcher in tasks.json.
  console.log('[watch] build started');
  await Promise.all(contexts.map((c) => c.rebuild()));
  console.log('[watch] build finished');
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
