import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const roots = ['src', 'test', 'scripts'];
const files = [];

async function collect(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(fullPath);
    else if (entry.isFile() && fullPath.endsWith('.js')) files.push(fullPath);
  }
}

for (const root of roots) await collect(root);
if (files.length === 0) {
  console.error('Syntax check failed: no JavaScript files found in src/, test/, or scripts/.');
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
