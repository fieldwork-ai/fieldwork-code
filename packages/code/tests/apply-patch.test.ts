import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PatchExecutor as Executor, nodePatchFS, type PatchParams, type PatchFS } from '../src/agent/tools/apply-patch.js';
import { parsePatch, updateText } from '../src/agent/tools/patch-format.js';
import { runnerRoots, runnerSignal } from '../src/agent/tools/workspace.js';
import { cases, rejected } from './patch-cases.js';

class PatchExecutor extends Executor {
  override run(params: PatchParams) { return runnerRoots.run([params.workdir!], () => super.run(params)); }
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(before: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fieldwork-patch-test-')));
  roots.push(root);
  for (const [path, content] of Object.entries(before)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
async function snapshot(root: string): Promise<Record<string, Buffer>> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const result: Record<string, Buffer> = {};
  for (const file of files) if (file.isFile()) {
    const path = join(file.parentPath, file.name);
    result[path.slice(root.length + 1).replaceAll('\\', '/')] = await readFile(path);
  }
  return result;
}
const bytes = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)]));
const request = (root: string, patch: string): PatchParams => ({ workdir: root, patch: `*** Begin Patch\n${patch}\n*** End Patch` });

describe('Codex-style compatibility corpus', () => {
  for (const test of cases) it(test.name, async () => {
    const root = await fixture(test.before);
    const result = await new PatchExecutor().run(request(root, test.patch));
    expect(result, result.error).toMatchObject({ success: true, status: 'applied' });
    expect(await snapshot(root)).toEqual(bytes(test.after));
  });
  for (const test of rejected) it(`rejects ${test.name}`, async () => {
    const root = await fixture(test.before);
    const result = await new PatchExecutor().run(request(root, test.patch));
    expect(result).toMatchObject({ success: false, status: 'rejected' });
    expect(await snapshot(root)).toEqual(bytes(test.before));
  });
});

it('needs only the approved patch, not preapproval state', async () => {
  const root = await fixture({ a: 'old\n' });
  const approvedInput = JSON.parse(JSON.stringify(request(root, '*** Update File: a\n@@\n-old\n+new')));
  expect((await new PatchExecutor().run(approvedInput)).success).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('new\n');
});

it('uses current context, preserves unrelated edits, and rejects missing old text', async () => {
  const root = await fixture({ a: 'unrelated\nold\n' });
  const input = request(root, '*** Update File: a\n@@\n-old\n+new');
  await writeFile(join(root, 'a'), 'user edit\nold\n');
  expect((await new PatchExecutor().run(input)).success).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('user edit\nnew\n');
  expect((await new PatchExecutor().run(input)).success).toBe(false);
});

it('preflight is complete before the first file is changed', async () => {
  const root = await fixture({ a: 'old\n', b: 'old\n' });
  const result = await new PatchExecutor().run(request(root, '*** Update File: a\n@@\n-old\n+new\n*** Update File: b\n@@\n-missing\n+new'));
  expect(result.status).toBe('rejected');
  expect(await snapshot(root)).toEqual(bytes({ a: 'old\n', b: 'old\n' }));
});

it('rejects paired-root escapes and symlinks', async () => {
  const root = await fixture({ a: 'old\n' }), outside = await fixture({ secret: 'private\n' });
  const executor = new PatchExecutor();
  expect((await executor.run(request(root, `*** Delete File: ${join(outside, 'secret')}`))).success).toBe(false);
  expect((await executor.run(request(root, '*** Add File: ../outside-file\n+x'))).success).toBe(false);
  if (process.platform !== 'win32') {
    await symlink(join(outside, 'secret'), join(root, 'link'));
    expect((await executor.run(request(root, '*** Delete File: link'))).success).toBe(false);
    await symlink(outside, join(root, 'directory'));
    expect((await executor.run(request(root, '*** Add File: directory/new\n+x'))).success).toBe(false);
  }
  expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('private\n');
});

it('does not execute a canceled batch', async () => {
  const root = await fixture({ a: 'old\n' });
  const controller = new AbortController(); controller.abort();
  expect((await runnerSignal.run(controller.signal, () => new PatchExecutor().run(request(root, '*** Delete File: a')))).success).toBe(false);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('old\n');
});

it('preserves executable permissions', async () => {
  if (process.platform === 'win32') return;
  const root = await fixture({ a: 'old\n' }); await chmod(join(root, 'a'), 0o751);
  expect((await new PatchExecutor().run(request(root, '*** Update File: a\n@@\n-old\n+new'))).success).toBe(true);
  expect((await stat(join(root, 'a'))).mode & 0o777).toBe(0o751);
});

it('rejects binary input, invalid UTF-8, oversized patches and malformed boundaries', async () => {
  const root = await fixture({ a: 'a\0b' });
  expect((await new PatchExecutor().run(request(root, '*** Delete File: a'))).success).toBe(false);
  await writeFile(join(root, 'a'), Buffer.from([0xff]));
  expect((await new PatchExecutor().run(request(root, '*** Delete File: a'))).success).toBe(false);
  for (const input of ['', 'bad', '*** Begin Patch\n*** Add File: a\n+x', 'x'.repeat(1024 * 1024 + 1)]) expect(() => parsePatch(input)).toThrow();
});

it.each(['stage', 'rename', 'remove'] as const)('reports injected %s failure', async operation => {
  const root = await fixture({ a: 'a\n', b: 'b\n' });
  const fail = () => { throw Object.assign(new Error('Injected I/O failure'), { code: 'EACCES' }); };
  const io: PatchFS = { ...nodePatchFS };
  if (operation === 'stage') io.stage = async () => fail();
  if (operation === 'rename') io.rename = async (from, to) => to === join(root, 'b') ? fail() : nodePatchFS.rename(from, to);
  if (operation === 'remove') io.remove = async path => path === join(root, 'b') ? fail() : nodePatchFS.remove(path);
  const input = request(root, operation === 'remove' ? '*** Delete File: a\n*** Delete File: b' : '*** Update File: a\n@@\n-a\n+A\n*** Update File: b\n@@\n-b\n+B');
  const result = await new PatchExecutor(io).run(input);
  expect(result.success).toBe(false);
  expect(result.status).toBe(operation === 'stage' ? 'failed' : 'uncertain');
  expect(result.applied).toEqual(operation === 'stage' ? [] : [join(root, 'a')]);
  expect((await readdir(root)).some(name => name.startsWith('.fieldwork-patch-'))).toBe(false);
});

it.each(['source', 'destination'])('rejects a %s race during staging', async target => {
  const root = await fixture({ a: 'old\n' });
  const io: PatchFS = { ...nodePatchFS, stage: async (...args) => {
    await nodePatchFS.stage(...args);
    await writeFile(join(root, target === 'source' ? 'a' : 'b'), 'external edit\n');
  } };
  const result = await new PatchExecutor(io).run(request(root, '*** Update File: a\n*** Move to: b\n@@\n-old\n+new'));
  expect(result.success).toBe(false);
  expect(result.applied).toEqual([]);
  expect(await readFile(join(root, target === 'source' ? 'a' : 'b'), 'utf8')).toBe('external edit\n');
});

it('reports a move destination committed before source deletion fails', async () => {
  const root = await fixture({ a: 'old\n' });
  const io: PatchFS = { ...nodePatchFS, remove: async path => {
    if (path === join(root, 'a')) throw new Error('Source removal failed');
    await nodePatchFS.remove(path);
  } };
  const result = await new PatchExecutor(io).run(request(root, '*** Update File: a\n*** Move to: b\n@@\n-old\n+new'));
  expect(result).toMatchObject({ success: false, status: 'uncertain', applied: [join(root, 'b')] });
  expect(await snapshot(root)).toEqual(bytes({ a: 'old\n', b: 'new\n' }));
});

it('supports pure moves, absolute paths and a selected initial directory', async () => {
  const root = await fixture({ 'src/a': 'unchanged\n' });
  const result = await new PatchExecutor().run({ ...request(root, `*** Update File: a\n*** Move to: ${join(root, 'b')}`), initial_cwd: join(root, 'src') });
  expect(result.success).toBe(true);
  expect(await snapshot(root)).toEqual(bytes({ b: 'unchanged\n' }));
});

it('generated exact edits preserve surrounding bytes', () => {
  for (let index = 0; index < 200; index++) {
    const ending = index % 2 ? '\r\n' : '\n';
    const before = `before${ending}target-${index}${ending}after${ending}`;
    const [operation] = parsePatch(`*** Begin Patch\n*** Update File: a\n@@\n-target-${index}\n+replacement-${index}\n*** End Patch`);
    expect(updateText(before, operation.chunks)).toBe(`before${ending}replacement-${index}${ending}after${ending}`);
  }
});
