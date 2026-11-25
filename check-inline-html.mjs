import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\\bsrc\\s*=)[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]).filter(source => source.trim());
if (!scripts.length) throw new Error('No inline JavaScript found in index.html');
const temp = join(tmpdir(), 'meme-radar-inline-check.js');
try {
  writeFileSync(temp, scripts.join('\\n;\\n'));
  const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Inline script syntax check failed\\n');
    process.exit(result.status || 1);
  }
  process.stdout.write('Checked ' + scripts.length + ' inline script block(s) in index.html\\n');
} finally {
  try { unlinkSync(temp); } catch {}
}
