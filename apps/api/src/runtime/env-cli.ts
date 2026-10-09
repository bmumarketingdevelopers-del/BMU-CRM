// `pnpm env:check`: checks apps/api/.env the same way the API does at start-up, without starting anything.
import 'dotenv/config';
import { checkEnv } from './env.js';

const r = checkEnv();
for (const e of r.errors) console.log(`✗ ${e}`);
for (const w of r.warnings) console.log(`! ${w}`);
for (const o of r.optional) console.log(`${o.on ? '✓' : '·'} ${o.name}${o.on ? '' : ' (built-in fallback)'}`);
console.log(r.errors.length ? '\nFix the ✗ lines before starting.' : `\nReady to start (${process.env.NODE_ENV ?? 'development'}).`);
process.exit(r.errors.length ? 1 : 0);
