import { createHash } from 'node:crypto';

/**
 * Shared filer for the quality lab (#21): a source script builds `Finding`s, this module drops the
 * ones already filed, prints a preview for review, and files the batch only when the reviewed id is
 * passed back. `gh` is injected, so nothing here touches the network by itself. Two filing runs at
 * the same time are not supported.
 */

/** Runs `gh` with `argv` (without `gh` itself) and optional stdin. */
export type Gh = (argv: string[], stdin?: string) => GhResult | Promise<GhResult>;
export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Titles, bodies and fingerprints must already be public-safe: the source script owns them. */
export interface Finding {
  source: string;
  title: string;
  body: string;
  fingerprints: string[];
}

export interface Plan {
  toFile: Finding[];
  duplicates: Finding[];
  overflow: Finding[];
}

/** Values in `secrets` are replaced by `***` in every message thrown. */
interface GhContext {
  gh: Gh;
  secrets: Record<string, string>;
}

const SOURCE_RE = /^[a-z0-9_-]+$/;
const FINGERPRINT_RE = /^[a-z0-9:_.-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The source has no `:`, so the first `:` splits it from the fingerprint.
const MARKER_RE = /<!-- finding: ([a-z0-9_-]+):([a-z0-9:_.-]+) -->/g;

const isText = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);

/** The hidden comment that marks an issue as filed. Invalid input throws without echoing it. */
export function marker(source: string, fingerprint: string): string {
  if (!isText(source, SOURCE_RE)) throw new Error('invalid finding source: expected non-empty [a-z0-9_-]');
  if (!isText(fingerprint, FINGERPRINT_RE)) throw new Error('invalid finding fingerprint: expected non-empty [a-z0-9:_.-]');
  return `<!-- finding: ${source}:${fingerprint} -->`;
}

function checkRepo(repo: string): void {
  if (!isText(repo, REPO_RE)) throw new Error('invalid repository: expected owner/name');
}

function redact(message: string, ...secrets: Array<Record<string, string>>): string {
  // Longest first, so a secret that contains a shorter one is still replaced whole.
  // Each value also in its JSON-escaped form, which a tool may print for a multiline secret.
  const all = secrets.flatMap((s) => Object.values(s));
  const values = all.filter((v) => typeof v === 'string' && v !== '').flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
  return values.sort((a, b) => b.length - a.length).reduce((out, v) => out.split(v).join('***'), message);
}

/** Runs `fn` and rethrows any failure as a fresh Error with a redacted message and, on purpose,
 *  no `cause`: the original error still carries the raw message. */
function redacting<T>(live: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const initial = { ...live }; // a secret rotated during the call is redacted in both its old and new value
  return fn().catch((e: unknown) => {
    throw new Error(redact(e instanceof Error ? e.message : String(e), initial, live));
  });
}

/** The fingerprints of `source` already filed in `repo`, open or closed. Pull requests are skipped. */
export function listFiled(repo: string, source: string, { gh, secrets }: GhContext): Promise<Set<string>> {
  return redacting(secrets, async () => {
    checkRepo(repo);
    marker(source, 'x'); // validates the source
    const r = await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`]);
    if (r.code !== 0) throw new Error(`gh api failed (exit ${r.code}): ${r.stderr}`);
    let pages: unknown;
    try {
      pages = JSON.parse(r.stdout);
    } catch {
      throw new Error('gh api output is not JSON');
    }
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('gh api output is not an array of pages');
    const found = new Set<string>();
    for (const item of (pages as unknown[][]).flat()) {
      // A number, an array, null or an error object has no integer `number`, so it is rejected here.
      const { number, body, pull_request } = Object(item) as { number?: unknown; body?: unknown; pull_request?: unknown };
      if (!Number.isSafeInteger(number)) throw new Error('gh api page item has no issue number');
      if (body !== null && typeof body !== 'string') throw new Error('gh api issue body is missing or not a string');
      if (pull_request) continue;
      for (const m of (body ?? '').matchAll(MARKER_RE)) if (m[1] === source) found.add(m[2]!);
    }
    return found;
  });
}

/** Keeps input order. Throws on a finding without fingerprints (it could never be deduplicated) or a cap that is not an integer >= 0. */
export function planBatch(findings: Finding[], filed: Set<string>, max = 10): Plan {
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('max must be a non-negative integer');
  const seen = new Set(filed);
  const plan: Plan = { toFile: [], duplicates: [], overflow: [] };
  for (const f of findings) {
    if (!Array.isArray(f.fingerprints) || f.fingerprints.length === 0) throw new Error('a finding needs at least one fingerprint');
    for (const fp of f.fingerprints) marker(f.source, fp);
    if (f.fingerprints.some((fp) => seen.has(fp))) plan.duplicates.push(f);
    else if (plan.toFile.length >= max) plan.overflow.push(f);
    else {
      plan.toFile.push(f);
      for (const fp of f.fingerprints) seen.add(fp);
    }
  }
  return plan;
}

interface Item {
  source: string;
  title: string;
  body: string;
}

/** A copy of what will be posted: the id is computed from it and `fileBatch` posts exactly it. */
function freeze(toFile: Finding[]): Item[] {
  return toFile.map((f) => {
    if (typeof f.title !== 'string' || typeof f.body !== 'string') throw new Error('a finding title and body must be strings');
    return { source: f.source, title: f.title, body: `${f.body}\n\n${f.fingerprints.map((fp) => marker(f.source, fp)).join('\n')}` };
  });
}

function digest(repo: string, labels: string[], items: Item[]): string {
  const json = JSON.stringify({ repo, labels, findings: items.map(({ title, body }) => ({ title, body })) });
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

/** First 12 hex characters of the SHA-256 of the repository, the labels and each kept title and final body. */
export function batchId({ repo, labels, toFile }: { repo: string; labels: string[]; toFile: Finding[] }): string {
  return digest(repo, labels, freeze(toFile));
}

/** Shows control characters (a carriage return or an ANSI escape could hide text in a terminal) and
 *  Unicode line separators as `\uXXXX`, so the reviewer sees exactly what will be posted. */
const visible = (s: string, keep: string) =>
  [...s].map((c) => {
    const code = c.codePointAt(0)!;
    const hidden = (code < 0x20 && !keep.includes(c)) || code === 0x7f || code === 0x2028 || code === 0x2029;
    return hidden ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }).join('');
/** A title always takes one preview line. */
const oneLine = (s: string) => visible(s.replace(/\\/g, '\\\\'), '');

/** Prints (and returns) the preview: each kept finding in full, one line per skipped finding, the id and the command. */
export function renderPreview(plan: Plan, { repo, labels, command }: { repo: string; labels: string[]; command: string }): string {
  const items = freeze(plan.toFile);
  const id = digest(repo, labels, items);
  const lines = [`${items.length} to file in ${repo} with labels ${labels.join(', ')}`];
  for (const item of items) lines.push('', `### ${oneLine(item.title)}`, visible(item.body, '\n\t'));
  lines.push('');
  for (const f of plan.duplicates) lines.push(`duplicate: ${oneLine(f.title)}`);
  for (const f of plan.overflow) lines.push(`overflow: ${oneLine(f.title)}`);
  lines.push(`batch id: ${id}`, `to file: ${command} --confirm ${id}`);
  const out = lines.join('\n');
  console.log(out);
  return out;
}

/**
 * Files the batch only when `confirm` is its id and `labels` has `source:<source>` for each finding.
 * One `gh issue create` per kept finding; the first failure stops the batch and its error lists the
 * URLs created so far.
 */
export function fileBatch(
  plan: Plan,
  { repo, labels, confirm, gh, secrets }: { repo: string; labels: string[]; confirm: string } & GhContext,
): Promise<string[]> {
  return redacting(secrets, async () => {
    checkRepo(repo);
    // Freeze everything before the first call, so a plan changed while filing cannot post unconfirmed text.
    const items = freeze(plan.toFile);
    const labelArgs = [...labels].flatMap((l) => ['--label', l]);
    const id = digest(repo, labels, items);
    if (confirm !== id) throw new Error('batch not confirmed: the id does not match this batch; review the preview and pass its id');
    for (const { source } of items) {
      if (!labels.includes(`source:${source}`)) throw new Error(`labels lack source:${source}`);
    }
    const urls: string[] = [];
    try {
      for (const item of items) {
        const r = await gh(['issue', 'create', '-R', repo, '--title', item.title, '--body-file', '-', ...labelArgs], item.body);
        if (r.code !== 0) throw new Error(`gh issue create failed (exit ${r.code}): ${r.stderr}`);
        const url = r.stdout.trim();
        if (!/^https:\/\/\S+\/issues\/\d+$/.test(url)) throw new Error('gh issue create did not print an issue URL');
        urls.push(url);
      }
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; created so far: ${urls.join(' ') || 'none'}`, { cause: e });
    }
    return urls;
  });
}
