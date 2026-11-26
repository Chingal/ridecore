import { describe, expect, it, vi } from 'vitest';
import { batchId, fileBatch, listFiled, marker, planBatch, renderPreview, type Finding, type GhResult } from '../../../scripts/findings/github.ts';

const REPO = 'owner/repo';
const LABELS = ['bug', 'source:glitchtip'];
const url = (n: number) => `https://github.com/owner/repo/issues/${n}`;

type Reply = Partial<GhResult> | ((argv: string[]) => Partial<GhResult>);
/** Fake `gh`: records argv and stdin, answers with the reply at the call index (the last one repeats). */
function fakeGh(...replies: Reply[]) {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const gh = (argv: string[], stdin?: string): GhResult => {
    calls.push({ argv, stdin });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    const r = typeof reply === 'function' ? reply(argv) : reply;
    return { stdout: '', stderr: '', code: 0, ...r };
  };
  return { gh, calls };
}

const finding = (title: string, fingerprints = [title.toLowerCase().replace(/[^a-z0-9]+/g, '-')], body = `body of ${title}`): Finding => ({ source: 'glitchtip', title, body, fingerprints });
const final = (f: Finding) => `${f.body}\n\n${f.fingerprints.map((fp) => marker(f.source, fp)).join('\n')}`;
const slurp = (...pages: object[][]) => JSON.stringify(pages.map((page) => page.map((item, i) => ({ number: i + 1, ...item }))));
const failure = (run: Promise<unknown>) => run.then(() => expect.unreachable('expected a rejection'), (e: unknown) => e as Error);
const filedVia = (stdout: string, extra: Partial<GhResult> = {}) => listFiled(REPO, 'glitchtip', { gh: fakeGh({ stdout, ...extra }).gh, secrets: {} });

describe('lists filed fingerprints across pages and sources', () => {
  it('reads every page, open and closed, of this source only', async () => {
    const pageOne = [
      { body: `open\n${marker('glitchtip', 'match-1')}\n${marker('glitchtip', 'second-fp')}` },
      { body: null },
      { body: marker('glitchtip', 'from-a-pr'), pull_request: { url: 'x' } },
      { body: `${marker('sonarqube', 'other-source')} ${marker('glitchtip-staging', 'prefix-source')}` },
    ];
    const pageTwo = [{ state: 'closed', body: `closed\n${marker('glitchtip', 'match-2')}` }];
    const { gh, calls } = fakeGh({ stdout: slurp(pageOne, pageTwo) });
    const filed = await listFiled(REPO, 'glitchtip', { gh, secrets: {} });
    expect(calls.map((c) => c.argv)).toEqual([['api', '--paginate', '--slurp', 'repos/owner/repo/issues?state=all&per_page=100']]);
    expect([...filed].sort()).toEqual(['match-1', 'match-2', 'second-fp']);
    expect(marker('glitchtip', 'a:b.c_d-1')).toBe('<!-- finding: glitchtip:a:b.c_d-1 -->');
  });

  it.each([
    ['an uppercase source', 'Bad', 'fp'], ['a source with a colon', 'a:b', 'fp'], ['an empty source', '', 'fp'],
    ['a non-string source', undefined, 'fp'], ['an uppercase fingerprint', 'src', 'FP'], ['a fingerprint with a slash', 'src', 'a/b'],
    ['an empty fingerprint', 'src', ''], ['a non-string fingerprint', 'src', 7],
  ])('marker rejects %s', (_case, source, fp) => expect(() => marker(source as string, fp as string)).toThrow(/invalid finding/));

  it('rejects a bad source before calling gh', async () => {
    const { gh, calls } = fakeGh({ stdout: slurp([]) });
    await expect(listFiled(REPO, 'Bad Source', { gh, secrets: {} })).rejects.toThrow(/invalid finding source/);
    expect(calls).toHaveLength(0);
  });

  it.each<[string, string, Partial<GhResult>?]>([
    ['a failing gh, even with valid JSON', slurp([]), { code: 1, stderr: 'boom' }],
    ['output that is not JSON', 'not json'],
    ['an array of issues, not of pages', JSON.stringify([{ number: 1, body: '' }])],
    ['an error object in place of an issue', '[[{"message":"lookup failed"}]]'],
    ['a page item that is a number', '[[42]]'],
    ['a page item that is an array', '[[[]]]'],
    ['a body that is not a string', JSON.stringify([[{ number: 1, body: 42 }]])],
    ['an issue without a body', '[[{"number":8}]]'],
    ['an item without an issue number', '[[{"body":""}]]'],
  ])('throws on %s', async (_case, stdout, extra) => expect(filedVia(stdout, extra)).rejects.toThrow(/gh api/));
});

describe('plans a batch without duplicates', () => {
  it('drops filed and repeated findings, keeps order and caps the batch', () => {
    const findings = [
      finding('filed', ['old-1']),
      finding('keep-z', ['new-1', 'new-5']), // not alphabetical, so sorting by title fails
      finding('repeat-of-z', ['new-5']), // repeats keep-z's second fingerprint
      finding('mixed', ['new-2', 'old-1']), // one new, one filed: a duplicate, and new-2 stays free
      finding('keep-b', ['new-2']),
    ];
    const p = planBatch(findings, new Set(['old-1']));
    expect(p.toFile.map((f) => f.title)).toEqual(['keep-z', 'keep-b']);
    expect(p.duplicates.map((f) => f.title)).toEqual(['filed', 'repeat-of-z', 'mixed']);
    expect(p.overflow).toEqual([]);

    const many = Array.from({ length: 12 }, (_, i) => finding(`k${i}`));
    expect(planBatch(many, new Set()).overflow.map((f) => f.title)).toEqual(['k10', 'k11']); // default cap is 10
    const capped = planBatch([finding('dup', ['old-1']), ...many.slice(0, 3)], new Set(['old-1']), 2);
    expect([capped.toFile, capped.duplicates, capped.overflow].map((l) => l.map((f) => f.title))).toEqual([['k0', 'k1'], ['dup'], ['k2']]);
    expect(planBatch(many.slice(0, 1), new Set(), 0).overflow).toHaveLength(1); // a cap of 0 keeps none
  });

  const base = { repo: REPO, labels: LABELS, toFile: [finding('a', ['fp-a'], 'body-a')] };
  it('gives a stable SHA-256 batch id', () => {
    expect(batchId(base)).toBe('0d1bcc4d7915'); // golden: pins SHA-256 and the serialization
    expect(batchId({ ...base, toFile: [{ ...base.toFile[0]! }] })).toBe(batchId(base));
  });

  it.each([
    ['the repository', { ...base, repo: 'owner/other' }],
    ['a label', { ...base, labels: ['bug', 'source:sonarqube'] }],
    ['a title', { ...base, toFile: [finding('z', ['fp-a'], 'body-a')] }],
    ['a body', { ...base, toFile: [finding('a', ['fp-a'], 'body-z')] }],
    ['a fingerprint', { ...base, toFile: [finding('a', ['fp-z'], 'body-a')] }],
  ])('changes the batch id with %s', (_case, input) => expect(batchId(input)).not.toBe(batchId(base)));

  it.each([1.5, -1, Infinity, Number.NaN, '3' as unknown as number])('rejects the cap %s', (max) =>
    expect(() => planBatch([finding('a')], new Set(), max)).toThrow(/non-negative integer/));

  it.each<[string, Finding]>([
    ['no fingerprint', finding('a', [])],
    ['a bad fingerprint', finding('a', ['Not Valid'])],
  ])('rejects a finding with %s', (_case, f) => expect(() => planBatch([f], new Set())).toThrow());
});

it('preview shows what will be filed', () => {
  const kept = [finding('Keep one'), finding('Keep\u2028two', ['keep-two'], 'shown\rhidden\n\u001b[2Kgone')];
  const p = { toFile: kept, duplicates: [finding('Already\nfiled')], overflow: [finding('Too\r\nmany\u2028here')] };
  const id = batchId({ repo: REPO, labels: LABELS, toFile: kept });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const out = renderPreview(p, { repo: REPO, labels: LABELS, command: 'make file-findings' });
  expect(log.mock.calls).toEqual([[out]]);
  log.mockRestore();

  expect(out).toContain(`### Keep one\n${final(kept[0]!)}`);
  expect(out).toContain(`### Keep\\u2028two\nshown\\u000dhidden\n\\u001b[2Kgone\n\n${marker('glitchtip', 'keep-two')}`);
  const lines = out.split('\n');
  expect(lines.filter((l) => /Already|filed$/.test(l))).toEqual(['duplicate: Already\\u000afiled']);
  expect(lines.filter((l) => /Too|many/.test(l))).toEqual(['overflow: Too\\u000d\\u000amany\\u2028here']);
  expect(lines.slice(-2)).toEqual([`batch id: ${id}`, `to file: make file-findings --confirm ${id}`]);
});

describe('files only the confirmed batch', () => {
  const three = () => [finding('first', ['fp-1', 'fp-1b']), finding('second'), finding('third')];
  const run = (toFile: Finding[], gh: ReturnType<typeof fakeGh>['gh'], labels = LABELS, confirm = batchId({ repo: REPO, labels, toFile })) =>
    // Non-empty skipped lists: filing a duplicate or an overflow finding must fail this group.
    fileBatch({ toFile, duplicates: [finding('dup')], overflow: [finding('over')] }, { repo: REPO, labels, confirm, gh, secrets: {} });

  it('refuses a wrong id or a missing source label, then files one issue per finding', async () => {
    const refused = fakeGh({ stdout: url(1) });
    await expect(run(three(), refused.gh, LABELS, 'deadbeef0000')).rejects.toThrow(/not confirmed/);
    await expect(run(three(), refused.gh, ['bug'])).rejects.toThrow(/source:glitchtip/);
    expect(refused.calls).toHaveLength(0);

    const toFile = three();
    const ok = fakeGh({ stdout: `${url(1)}\n` }, { stdout: url(2) }, { stdout: url(3) });
    await expect(run(toFile, ok.gh)).resolves.toEqual([url(1), url(2), url(3)]);
    expect(ok.calls).toEqual(toFile.map((f) => ({
      argv: ['issue', 'create', '-R', REPO, '--title', f.title, '--body-file', '-', '--label', 'bug', '--label', 'source:glitchtip'],
      stdin: final(f),
    })));
  });

  it('posts the confirmed text even if the plan changes while filing', async () => {
    const toFile = three();
    const confirmed = toFile.map((f) => [f.title, final(f)]);
    const fake = fakeGh(() => {
      toFile[1] = finding('swapped', ['fp-x'], 'unreviewed');
      return { stdout: url(1) };
    });
    await run(toFile, fake.gh, LABELS, batchId({ repo: REPO, labels: LABELS, toFile }));
    expect(fake.calls.map((c) => [c.argv[5], c.stdin])).toEqual(confirmed);
  });

  it.each<[string, Reply]>([
    ['a non-zero exit', { code: 1, stdout: url(2), stderr: 'create failed' }],
    ['a thrown runner', () => { throw new Error('spawn failed'); }],
    ['output that is not an issue URL', { stdout: '' }],
  ])('stops at the first failure (%s) and reports the URLs created so far', async (_case, second) => {
    const fake = fakeGh({ stdout: url(1) }, second, { stdout: url(3) });
    const err = await failure(run(three(), fake.gh));
    expect(fake.calls).toHaveLength(2);
    expect(err.message).toMatch(new RegExp(`created so far: ${url(1)}$`));
  });
});

it('diagnostics never show secrets', async () => {
  const TOKEN = 'ghp_secretvalue123';
  const MULTI = 'line-one\nline-two-secret';
  const secrets: Record<string, string> = { PART: 'secretvalue', TOKEN, MULTI, EMPTY: '' }; // PART inside TOKEN: longest must go first
  const toFile = [finding('t'), finding('second')];
  const labels = ['source:glitchtip'];
  const confirm = batchId({ repo: REPO, labels, toFile });
  const echo = { code: 1, stderr: `denied for ${TOKEN} and ${MULTI} and ${JSON.stringify(MULTI)}` };
  const crash = () => { throw new Error(`crashed with ${TOKEN} ${MULTI}`); };
  const file = (gh: ReturnType<typeof fakeGh>['gh'], items = toFile) => fileBatch({ toFile: items, duplicates: [], overflow: [] }, { repo: REPO, labels, confirm, gh, secrets });
  const printed: string[] = [];
  const sink = (...a: unknown[]) => void printed.push(a.map(String).join(' '));
  const spies = [
    ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(sink)),
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (sink(c), true)),
  ];
  const errors = [
    await failure(listFiled(REPO, 'glitchtip', { gh: fakeGh(echo).gh, secrets })),
    await failure(listFiled(REPO, 'glitchtip', { gh: crash, secrets })),
    await failure(file(fakeGh({ stdout: url(1) }, echo).gh)),
    await failure(file(fakeGh(crash).gh)),
    await failure(file(fakeGh().gh, [finding('t', [MULTI])])), // an invalid fingerprint equal to a secret
    // Rotated mid-call (last): both the old and the new value must be hidden.
    await failure(listFiled(REPO, 'glitchtip', { gh: () => ((secrets.TOKEN = 'ghp_rotated'), { stdout: '', ...echo, stderr: `${echo.stderr} ghp_rotated` }), secrets })),
  ];
  for (const s of spies) s.mockRestore();

  for (const text of [...errors.map((e) => e.message), ...printed]) {
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('line-two-secret');
  }
  expect(errors.slice(0, 4).every((e) => e.message.includes('***'))).toBe(true);
  expect(errors.every((e) => e.cause === undefined)).toBe(true); // a cause would carry the raw message
});
