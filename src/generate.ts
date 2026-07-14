import { npmHighImpact } from 'npm-high-impact';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Manifest,
  REGISTRY,
  fetchReadme,
  fetchWithRetry,
  parseGithubRepo,
} from './github.ts';

const FAST_NPM_META = 'https://npm.antfu.dev';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_DIR = join(ROOT, 'readmes');

/** Packages resolved per fast-npm-meta request. */
const VERSION_BATCH_SIZE = 50;
/** Concurrent package downloads. */
const CONCURRENCY = 20;

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await fn(item, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Resolves the latest published version for each package using the batched
 * fast-npm-meta endpoint. Packages that error out (unpublished, invalid) are
 * omitted from the result.
 */
async function resolveVersions(
  names: readonly string[],
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += VERSION_BATCH_SIZE) {
    batches.push(names.slice(i, i + VERSION_BATCH_SIZE));
  }

  let done = 0;
  await mapWithConcurrency(batches, CONCURRENCY, async (batch) => {
    const url = `${FAST_NPM_META}/${batch.join('+')}?throw=false`;
    try {
      const res = await fetchWithRetry(url);
      if (res.ok) {
        const data = (await res.json()) as unknown;
        const entries = Array.isArray(data) ? data : [data];
        for (const entry of entries as Array<Record<string, unknown>>) {
          if (
            typeof entry?.name === 'string' &&
            typeof entry.version === 'string'
          ) {
            versions.set(entry.name, entry.version);
          }
        }
      }
    } catch {
      // Skip the whole batch on network failure; a re-run will retry it.
    }
    done += batch.length;
    console.log(`\rResolving versions: ${done}/${names.length}`);
  });
  console.log('\n');
  return versions;
}

async function main(): Promise<void> {
  await mkdir(README_DIR, { recursive: true });

  // Resume: only consider packages we have not already written.
  const pending = npmHighImpact.filter((name) => !existsSync(readmePath(name)));
  console.log(
    `${npmHighImpact.length} packages total, ${pending.length} pending ` +
      `(${npmHighImpact.length - pending.length} already downloaded).`,
  );
  if (pending.length === 0) return;

  const versions = await resolveVersions(pending);
  const resolved = pending.filter((name) => versions.has(name));
  console.log(`Resolved ${resolved.length} versions. Downloading READMEs...`);

  const stats = {
    github: 0,
    nonGithub: 0,
    deprecated: 0,
    saved: 0,
    missing: 0,
    errors: 0,
  };
  let processed = 0;

  await mapWithConcurrency(resolved, CONCURRENCY, async (name) => {
    try {
      const version = versions.get(name)!;
      const manifestRes = await fetchWithRetry(
        `${REGISTRY}/${name}/${version}`,
      );
      if (!manifestRes.ok) {
        stats.errors++;
        return;
      }
      const manifest = (await manifestRes.json()) as Manifest;

      // Only interested in soft deprecations: skip anything npm already flags
      // as hard-deprecated on the registry.
      if (
        typeof manifest.deprecated === 'string' &&
        manifest.deprecated.trim() !== ''
      ) {
        stats.deprecated++;
        return;
      }

      const gh = parseGithubRepo(manifest);
      if (!gh) {
        stats.nonGithub++;
        return;
      }
      stats.github++;

      const readme = await fetchReadme(gh);

      if (readme === undefined || readme.text.trim() === '') {
        stats.missing++;
        return;
      }

      const path = readmePath(name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, readme.text);
      stats.saved++;
    } catch {
      stats.errors++;
    } finally {
      if (++processed % 50 === 0 || processed === resolved.length) {
        console.log(
          `\rDownloading: ${processed}/${resolved.length} ` +
            `(saved ${stats.saved}, non-github ${stats.nonGithub}, ` +
            `deprecated ${stats.deprecated}, ` +
            `missing ${stats.missing}, errors ${stats.errors})`,
        );
      }
    }
  });

  console.log('\n');
  console.log('Done.', stats);
}

function readmePath(name: string): string {
  return join(README_DIR, `${name}.md`);
}

await main();
