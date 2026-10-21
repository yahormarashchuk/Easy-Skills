import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function find(path) {
  return readdirSync(path, {withFileTypes: true}).flatMap(e => e.isDirectory() ? find(join(path, e.name)) : e.name.endsWith('.test.ts') ? [join(path, e.name)] : []);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...find('tests')], {stdio: 'inherit'});
process.exitCode = result.status ?? 1;
