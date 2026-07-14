import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_DIR = join(ROOT, 'readmes');
const OUTPUT = join(ROOT, 'deprecated.json');

/** Lines from the top of the README treated as the "header zone". */
const HEADER_LINES = 30;

/** Nouns that turn a heading into a feature/section notice, not a package one. */
const SECTION_NOUNS =
  'apis?|methods?|options?|features?|types?|props?|functions?|exports?|' +
  'components?|matchers?|hooks?|fields?|members?|symbols?|classes|events?|' +
  'endpoints?|params?|flags?|utils?|utilities|rules?|selectors?|helpers?|' +
  'directives?|modifiers?|attributes?|properties|imports?|aliases|names?';

/** Deprecation word anchored to a specific unrelated subject. */
const OFF_TOPIC = /deprecat\w*\s+(node|io\.?js|browsers?|npm|versions?)\b/i;

const NEGATED = /\b(non|not|isn'?t|aren'?t|never)[\s-]+deprecat/i;

type Confidence = 'high' | 'medium';

interface Finding {
  name: string;
  /** The README line (1-based) the notice was found on. */
  position: number;
  /** The matched deprecation notice text. */
  reason: string;
  confidence: Confidence;
}

/** Strips markdown emphasis, emoji, and alert/badge markers from a fragment. */
function stripMarkers(text: string): string {
  return text
    .replace(/\[!\w+\]/g, '')
    .replace(/:[a-z0-9_+-]+:/gi, '')
    .replace(/[*_`~>#|]/g, '')
    .replace(/[\p{Extended_Pictographic}️⬀-⯿←-⇿]/gu, '')
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
}

function headingText(line: string): string | undefined {
  const stripped = line.replace(/^\s{0,3}(?:>\s?)+/, '');
  const markdown = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(stripped);
  if (markdown) return markdown[2];
  const html = /^\s*<h[1-3][^>]*>(.*?)<\/h[1-3]>/i.exec(stripped);
  return html ? html[1] : undefined;
}

/**
 * True when a heading announces the whole package as deprecated, rather than a
 * subsection of deprecated features.
 */
function isPackageDeprecationHeading(
  text: string,
  packageName: string,
): boolean {
  const core = stripMarkers(text).replace(/`/g, '');
  const base = packageName.split('/').pop()!.toLowerCase();

  // Ignore a leading self-name so "`pkg` is deprecated" keeps its signal while
  // a title that is *only* the name (e.g. the `deprecated` package) is dropped.
  const withoutName = core
    .replace(new RegExp(`^${escapeRegExp(base)}\\b[\\s:–—-]*`, 'i'), '')
    .trim();
  if (withoutName === '') return false;
  const lower = withoutName.toLowerCase();

  const saysDeprecated =
    /^deprecat(ed|ion)\b/.test(lower) ||
    /^(warning|status|notice)\b[\s\S]*deprecat/.test(lower) ||
    /\b(is|are|has been|have been)\s+(?:now\s+|also\s+)?deprecated\b/.test(
      lower,
    );
  const saysUnmaintained =
    /\bno longer\s+(maintained|supported|actively\s+(maintained|developed)|developed)\b/.test(
      lower,
    ) ||
    /\b(unmaintained|not\s+maintained)\b/.test(lower) ||
    /已停止维护/.test(core);
  if (!saysDeprecated && !saysUnmaintained) return false;

  // "Deprecations" / "Deprecated options" etc. are feature sections.
  if (new RegExp(`^deprecat\\w*\\s+(${SECTION_NOUNS})\\b`, 'i').test(lower)) {
    return false;
  }
  if (/^deprecations\b/.test(lower)) return false;
  return true;
}

const DEPRECATED_STATE =
  '(?:deprecated|abandoned|unmaintained|discontinued|no longer\\s+' +
  '(?:maintained|supported|developed|actively\\s+\\w+|relevant|in use|available))';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes leading emoji, badges, markdown emphasis, and label prefixes. */
function stripClauseLead(text: string): string {
  let out = text;
  for (let k = 0; k < 8; k++) {
    const before = out;
    out = out.replace(/^<[^>]+>\s*/, '');
    out = out.replace(/^[\s>*_~#`|«»"'()[\]!.–—-]+/, '');
    out = out.replace(/^:[a-z0-9_+-]+:\s*/i, '');
    out = out.replace(/^[\p{Extended_Pictographic}️]+\s*/u, '');
    out = out.replace(
      /^(?:note|warning|deprecated|deprecation(?:\s+notice)?|notice|status|important|caution|attention|heads up|fyi|archived|obsolete|eol)\b\s*[:!–—-]*\s*/i,
      '',
    );
    if (out === before) break;
  }
  return out;
}

/**
 * Iterates the sentence-like clauses of a line with lead markers stripped and
 * inline emphasis/backticks removed, so subjects like "`pkg` has been …" align.
 */
function* cleanedClauses(line: string): Generator<string> {
  for (const clause of line.split(/(?<=[.!?])\s+/)) {
    yield stripClauseLead(clause).replace(/[`*_~]/g, '');
  }
}

/** Context that means a *different* package (usually a fork's origin) is dead. */
const FORK_CONTEXT =
  /\b(fork(ed)?\s+(from|of)|the original\b|originally\b|lower versions?|older versions?|previous versions?|the old\s+(package|module|library))\b/i;

/**
 * True when a line asserts, at the start of a clause, that the package itself
 * (by role — "this package/module/…" — or by its own name) is deprecated.
 */
function statesPackageDeprecated(
  line: string,
  packageName: string,
): string | undefined {
  const subject =
    `(?:this|the)\\s+(?:package|module|library|project|repo(?:sitory)?|` +
    `plugin|tool|action|cli|component|sdk|framework)|` +
    escapeRegExp(packageName) +
    `|${escapeRegExp('`' + packageName + '`')}`;
  const statement = new RegExp(
    `^(?:${subject})\\b(?:\\s*\\([^)]*\\))?\\s+` +
      `(?:is|has|have|was|were|are)\\s+(?:been\\s+|now\\s+|also\\s+|currently\\s+)*` +
      DEPRECATED_STATE,
    'i',
  );

  for (const text of cleanedClauses(line)) {
    if (statement.test(text) && !NEGATED.test(text) && !OFF_TOPIC.test(text)) {
      return text;
    }
  }
  return undefined;
}

/**
 * True when a clause says the package itself ("this <noun>" / "it") is no longer
 * maintained. Weaker than an explicit "deprecated", so callers treat it as
 * medium confidence; fork/version-scoped mentions are excluded.
 */
function statesPackageUnmaintained(line: string): string | undefined {
  if (NEGATED.test(line) || OFF_TOPIC.test(line) || FORK_CONTEXT.test(line)) {
    return undefined;
  }
  for (const text of cleanedClauses(line)) {
    if (
      /^(?:this|the|it)\b[\s\S]{0,60}?\bno longer\s+(maintained|supported)\b/i.test(
        text,
      )
    ) {
      return text;
    }
  }
  return undefined;
}

function scan(name: string, content: string): Finding | undefined {
  const lines = content.split(/\r?\n/);
  let confidence: Confidence | undefined;
  let reason = '';
  let position = 0;

  const record = (line: number, level: Confidence, snippet?: string): void => {
    // Keep the first notice found, but let a "high" match supersede a "medium".
    if (
      confidence !== undefined &&
      !(level === 'high' && confidence === 'medium')
    ) {
      return;
    }
    confidence = level;
    reason = (snippet ?? lines[line]!.trim()).slice(0, 200);
    position = line + 1;
  };

  let firstHeadingSeen = false;
  let nonEmptySeen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const heading = headingText(line);

    // First heading of the document is the strongest signal.
    if (heading !== undefined && !firstHeadingSeen) {
      firstHeadingSeen = true;
      if (
        isPackageDeprecationHeading(heading, name) &&
        !NEGATED.test(heading)
      ) {
        record(i, 'high');
      }
    } else if (
      heading !== undefined &&
      i < HEADER_LINES &&
      isPackageDeprecationHeading(heading, name) &&
      !NEGATED.test(heading)
    ) {
      // A deprecation heading still in the header zone (after a title/badges).
      record(i, 'high');
    }

    // A banner in the first few non-empty lines, before the real title.
    if (heading === undefined && nonEmptySeen < 3) {
      const core = stripMarkers(trimmed);
      if (
        /^deprecat(ed|ion)\b/i.test(core) &&
        !NEGATED.test(trimmed) &&
        !OFF_TOPIC.test(trimmed)
      ) {
        record(i, 'high');
      }
    }

    // An explicit statement that the package/module itself is deprecated.
    // Anchored to the start of a clause so that "the <feature> from this module
    // is deprecated" or "replacement for the deprecated X" do not match.
    if (i < HEADER_LINES) {
      const deprecated = statesPackageDeprecated(trimmed, name);
      const unmaintained = deprecated ?? statesPackageUnmaintained(trimmed);
      if (deprecated) {
        record(i, 'high', deprecated);
      } else if (nonEmptySeen < 8 && unmaintained) {
        record(i, 'medium', unmaintained);
      }
    }

    nonEmptySeen++;
    if (i >= HEADER_LINES && firstHeadingSeen && confidence !== undefined)
      break;
  }

  if (confidence === undefined) return undefined;
  return { name, position, reason, confidence };
}

async function collectReadmes(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectReadmes(full)));
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const files = await collectReadmes(README_DIR);
  const findings: Finding[] = [];

  for (const file of files) {
    const name = relative(README_DIR, file).replace(/\.md$/, '');
    const finding = scan(name, await readFile(file, 'utf8'));
    if (finding) findings.push(finding);
  }

  findings.sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );

  const output = findings.map(({ name, reason, position }) => ({
    name,
    reason,
    position,
  }));
  const json = JSON.stringify(output, null, 2) + '\n';

  await writeFile(OUTPUT, json);
  console.log(json);

  const high = findings.filter((f) => f.confidence === 'high').length;
  console.error(
    `Scanned ${files.length} READMEs. ${findings.length} deprecated ` +
      `(${high} high, ${findings.length - high} medium confidence). ` +
      `Wrote ${relative(ROOT, OUTPUT)}\n`,
  );
}

await main();
