export const RAW_GITHUB = 'https://raw.githubusercontent.com';
export const REGISTRY = 'https://registry.npmjs.org';

/** README filenames tried against GitHub raw before giving up. */
const RAW_README_NAMES = ['README.md', 'readme.md', 'Readme.md'];

export interface GithubRepo {
  owner: string;
  repo: string;
  directory: string | undefined;
}

export interface Manifest {
  repository?: string | { url?: string; directory?: string } | undefined;
  dist?: { tarball?: string } | undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
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

/** Extracts GitHub owner/repo/directory from an npm `repository` field. */
export function parseGithubRepo(manifest: Manifest): GithubRepo | undefined {
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

/** Repo-relative directory prefix (with trailing slash) for a package's README. */
function readmePrefix(gh: GithubRepo): string {
  return gh.directory ? `${gh.directory.replace(/^\/|\/$/g, '')}/` : '';
}

export interface Readme {
  text: string;
  /** Repo-relative path of the README that matched (e.g. `docs/README.md`). */
  file: string;
}

/** Reads the README from GitHub's raw CDN on the default branch. */
export async function fetchReadme(gh: GithubRepo): Promise<Readme | undefined> {
  const prefix = readmePrefix(gh);
  for (const name of RAW_README_NAMES) {
    const file = `${prefix}${name}`;
    const res = await fetchWithRetry(
      `${RAW_GITHUB}/${gh.owner}/${gh.repo}/HEAD/${file}`,
    );
    if (res.ok) return { text: await res.text(), file };
    // 404 means "not this filename"; keep the body drained and try the next.
    await res.arrayBuffer().catch(() => undefined);
  }
  return undefined;
}

/** GitHub blob URL for a repo-relative file on the default branch. */
export function blobUrl(gh: GithubRepo, file: string): string {
  return `https://github.com/${gh.owner}/${gh.repo}/blob/HEAD/${file}`;
}
