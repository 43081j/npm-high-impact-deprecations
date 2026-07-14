import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'deprecated.json');
const OUTPUT = join(ROOT, 'results.md');

const NPM_BASE = 'https://www.npmjs.com/package';

interface Entry {
  name: string;
  reason: string;
  line: number;
  repo?: string;
  url?: string;
}

/** Escapes the pipe character that would otherwise split a markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  const entries = JSON.parse(await readFile(INPUT, 'utf8')) as Entry[];
  const linked = entries.filter((entry) => entry.url).length;

  const rows = entries.map(({ name, url }) => {
    const pkg = `[\`${escapeCell(name)}\`](${NPM_BASE}/${name})`;
    const notice = url ? `[readme:${url.split('#L')[1]}](${url})` : '-';
    return `| ${pkg} | ${notice} |`;
  });

  const markdown = [
    '# Deprecated packages',
    '',
    `**Total:** ${entries.length} · **linked to source:** ${linked}`,
    '',
    '| Package | Notice |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');

  await writeFile(OUTPUT, markdown);
  console.log(`Wrote ${entries.length} rows to ${relative(ROOT, OUTPUT)}`);
}

await main();
