import { npmHighImpact } from 'npm-high-impact';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAST_NPM_META = 'https://npm.antfu.dev';
const REGISTRY = 'https://registry.npmjs.org';
const RAW_GITHUB = 'https://raw.githubusercontent.com';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_DIR = join(ROOT, 'readmes');

/** Packages resolved per fast-npm-meta request. */
const VERSION_BATCH_SIZE = 50;
/** Concurrent package downloads. */
const CONCURRENCY = 20;
/** README filenames tried against GitHub raw before falling back to the tarball. */
const RAW_README_NAMES = ['README.md', 'readme.md', 'Readme.md'];

interface GithubRepo {
  owner: string;
  repo: string;
  directory: string | undefined;
}

interface Manifest {
  repository?: string | { url?: string; directory?: string } | undefined;
  dist?: { tarball?: string } | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

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

/** Extracts GitHub owner/repo/directory from an npm `repository` field. */
function parseGithubRepo(manifest: Manifest): GithubRepo | undefined {
  const repository = manifest.repository;
  if (!repository) return undefined;

  const raw =
    typeof repository === 'string' ? repository : (repository.url ?? '');
  const directory =
    typeof repository === 'object' ? repository.directory : undefined;

  // Normalise the many forms npm allows into `owner/repo`.
  const normalised = raw
    .replace(/^git\+/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git:\/\//, 'https://');

  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/.exec(
    normalised,
  );
  if (!match) return undefined;

  const [, owner, repo] = match;
  if (!owner || !repo) return undefined;
  return { owner, repo, directory: directory || undefined };
}

/** Attempts to read the README from GitHub's raw CDN on the default branch. */
async function fetchReadmeFromGithub(
  gh: GithubRepo,
): Promise<string | undefined> {
  const prefix = gh.directory ? `${gh.directory.replace(/^\/|\/$/g, '')}/` : '';
  for (const name of RAW_README_NAMES) {
    const url = `${RAW_GITHUB}/${gh.owner}/${gh.repo}/HEAD/${prefix}${name}`;
    const res = await fetchWithRetry(url);
    if (res.ok) return res.text();
    // 404 means "not this filename"; keep the body drained and try the next.
    await res.arrayBuffer().catch(() => undefined);
  }
  return undefined;
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

  const stats = { github: 0, nonGithub: 0, saved: 0, missing: 0, errors: 0 };
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

      const gh = parseGithubRepo(manifest);
      if (!gh) {
        stats.nonGithub++;
        return;
      }
      stats.github++;

      let readme = await fetchReadmeFromGithub(gh);

      if (readme === undefined || readme.trim() === '') {
        stats.missing++;
        return;
      }

      const path = readmePath(name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, readme);
      stats.saved++;
    } catch {
      stats.errors++;
    } finally {
      if (++processed % 50 === 0 || processed === resolved.length) {
        console.log(
          `\rDownloading: ${processed}/${resolved.length} ` +
            `(saved ${stats.saved}, non-github ${stats.nonGithub}, ` +
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
