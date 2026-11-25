import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const scripts = [];
let cursor = 0;
while (true) {
  const start = html.indexOf('<script', cursor);
  if (start < 0) break;
  const tagEnd = html.indexOf('>', start);
  if (tagEnd < 0) throw new Error('Unclosed script tag');
  const tag = html.slice(start, tagEnd + 1).toLowerCase();
  const end = html.indexOf('</script>', tagEnd + 1);
  if (end < 0) throw new Error('Unclosed inline script');
  if (!tag.includes('src=') && !tag.includes('src =') && !tag.includes('src = ')) {
    const source = html.slice(tagEnd + 1, end);
    if (source.trim()) scripts.push(source);
  }
  cursor = end + 9;
}
if (!scripts.length) throw new Error('No inline JavaScript found in index.html');
const temp = join(tmpdir(), 'meme-radar-inline-check.js');
try {
  writeFileSync(temp, scripts.join(String.fromCharCode(10) + ';' + String.fromCharCode(10)));
  const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Inline script syntax check failed');
    process.exit(result.status || 1);
  }
  process.stdout.write('Checked ' + scripts.length + ' inline script block(s) in index.html');
} finally {
  try { unlinkSync(temp); } catch {}
}
