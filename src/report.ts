import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'deprecated.json');
const OUTPUT = join(ROOT, 'results.md');

const NPM_BASE = 'https://www.npmjs.com/package';
const DOWNLOADS_BASE = 'https://api.npmjs.org/downloads/point/last-week';

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

/** Fetches the last week's download count for a package, or 0 if unavailable. */
async function fetchDownloads(name: string): Promise<number> {
  try {
    const response = await fetch(`${DOWNLOADS_BASE}/${name}`);
    if (!response.ok) return 0;
    const data = (await response.json()) as { downloads?: number };
    return data.downloads ?? 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const entries = JSON.parse(await readFile(INPUT, 'utf8')) as Entry[];
  const linked = entries.filter((entry) => entry.url).length;

  const downloads = new Map(
    await Promise.all(
      entries.map(
        async (entry) =>
          [entry.name, await fetchDownloads(entry.name)] as const,
      ),
    ),
  );

  const sorted = [...entries].sort(
    (a, b) => (downloads.get(b.name) ?? 0) - (downloads.get(a.name) ?? 0),
  );

  const rows = sorted.map(({ name, url }) => {
    const pkg = `[\`${escapeCell(name)}\`](${NPM_BASE}/${name})`;
    const notice = url ? `[readme:${url.split('#L')[1]}](${url})` : '-';
    const weekly = (downloads.get(name) ?? 0).toLocaleString('en-US');
    return `| ${pkg} | ${weekly} | ${notice} |`;
  });

  const markdown = [
    '# Deprecated packages',
    '',
    `**Total:** ${entries.length} · **linked to source:** ${linked}`,
    '',
    '| Package | Weekly downloads | Notice |',
    '| --- | --: | --- |',
    ...rows,
    '',
  ].join('\n');

  await writeFile(OUTPUT, markdown);
  console.log(`Wrote ${entries.length} rows to ${relative(ROOT, OUTPUT)}`);
}

await main();
