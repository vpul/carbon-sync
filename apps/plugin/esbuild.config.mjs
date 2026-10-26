import { builtinModules } from 'node:module';
import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const external = [
  'obsidian',
  'electron',
  '@codemirror/*',
  '@lezer/*',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  mainFields: ['browser', 'module', 'main'],
  external,
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  minify: production,
  treeShaking: true,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
