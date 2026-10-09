// Bundles the compiled API (dist/serverless.js, after `nest build`) and every package it uses into ONE file,
// dist/vercel/serverless.mjs, which the website's /api function loads on Vercel (apps/web/src/pages/api/[...path].ts).
// One self-contained file is easy for Vercel to package: no node_modules tree to trace. TypeScript has already
// written the decorator metadata NestJS needs, so bundling the JavaScript changes nothing about how it runs.
import { build } from 'esbuild';

// Optional packages NestJS and others only load when a feature is used that BMU Hub does not use.
const optional = [
  '@nestjs/microservices',
  '@nestjs/microservices/*',
  '@nestjs/websockets',
  '@nestjs/websockets/*',
  '@nestjs/platform-socket.io',
  '@fastify/*',
  'class-validator',
  'class-transformer',
  'class-transformer/*',
  'pg-native',
  'cache-manager',
  '@mapbox/node-pre-gyp',
];

await build({
  entryPoints: ['dist/serverless.js'],
  outfile: 'dist/vercel/serverless.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: optional,
  // CommonJS packages inside an ES module bundle still call require() and read __dirname.
  banner: {
    js: [
      "import { createRequire as __bmuCreateRequire } from 'node:module';",
      "import { fileURLToPath as __bmuFileURLToPath } from 'node:url';",
      "import { dirname as __bmuDirname } from 'node:path';",
      'const require = __bmuCreateRequire(import.meta.url);',
      'const __filename = __bmuFileURLToPath(import.meta.url);',
      'const __dirname = __bmuDirname(__filename);',
    ].join('\n'),
  },
  // Keeps class names (NestJS uses them for providers and error messages).
  keepNames: true,
  logLevel: 'warning',
  legalComments: 'none',
});
console.log('Bundled the API into dist/vercel/serverless.mjs');
