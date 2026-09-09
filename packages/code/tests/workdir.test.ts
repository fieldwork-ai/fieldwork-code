import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRoot, workspacePathUnder, WORKSPACE, USER_FILES_ROOT } from '../src/agent/tools/workspace.js';
import { bash } from '../src/agent/tools/bash.js';
import { uploadArchive } from '../src/agent/tools/upload-archive.js';
import { downloadArchive } from '../src/agent/tools/download-archive.js';
import { upload } from '../src/agent/tools/upload.js';

/**
 * The per-request workdir contract (ADR 20260810): requests without a workdir
 * keep the historical $HOME anchoring; requests with one are rooted there;
 * /user_files is a second permitted root for the transfer tools only.
 */

describe('resolveRoot', () => {
  it('defaults to $HOME when absent', () => {
    const r = resolveRoot(undefined);
    expect(r).toEqual({ ok: true, root: WORKSPACE });
  });

  it('accepts a workdir under $HOME', () => {
    const r = resolveRoot(`${WORKSPACE}/conversations/abc`);
    expect(r).toEqual({ ok: true, root: `${WORKSPACE}/conversations/abc` });
  });

  it('rejects a workdir outside $HOME', () => {
    expect(resolveRoot('/etc').ok).toBe(false);
    expect(resolveRoot(USER_FILES_ROOT).ok).toBe(false);
    expect(resolveRoot(`${WORKSPACE}/../etc`).ok).toBe(false);
  });
});

describe('workspacePathUnder two-root rule', () => {
  const root = `${WORKSPACE}/conversations/abc`;

  it('anchors relative paths at the given root', () => {
    const r = workspacePathUnder('data/x.csv', root);
    expect(r).toEqual({ ok: true, path: `${root}/data/x.csv` });
  });

  it('accepts absolute paths under /user_files', () => {
    const r = workspacePathUnder(`${USER_FILES_ROOT}/reports/q3.xlsx`, root);
    expect(r).toEqual({ ok: true, path: `${USER_FILES_ROOT}/reports/q3.xlsx` });
  });

  it('still refuses escapes to anywhere else', () => {
    expect(workspacePathUnder('/etc/passwd', root).ok).toBe(false);
    expect(workspacePathUnder('../../../../etc', root).ok).toBe(false);
    expect(workspacePathUnder('/user_files_evil/x', root).ok).toBe(false);
  });

  it('keeps the historical $HOME-only behavior without a root', () => {
    expect(workspacePathUnder('notes.txt')).toEqual({ ok: true, path: `${WORKSPACE}/notes.txt` });
  });
});

describe('workdir-threaded tools', () => {
  let home: string;
  let workdir: string;

  beforeEach(async () => {
    // The tools root everything at $HOME, so point HOME at a scratch dir.
    // WORKSPACE is module-level const bound at import — use paths under the
    // REAL workspace instead, in a unique scratch subtree.
    home = await mkdtemp(join(tmpdir(), 'workdir-test-'));
    workdir = join(WORKSPACE, `.workdir-test-${Date.now()}`);
    await mkdir(workdir, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  it('bash runs with cwd = workdir and injected env', async () => {
    const result = await bash({
      command: 'pwd && echo "$FIELDWORK_TOKEN"',
      workdir,
      env: { FIELDWORK_TOKEN: 'tok-123' },
    });
    expect(result.success).toBe(true);
    const stdout = String(result.stdout);
    expect(stdout).toContain(workdir);
    expect(stdout).toContain('tok-123');
  });

  it('bash creates a missing workdir lazily', async () => {
    const fresh = join(workdir, 'nested/deeper');
    const result = await bash({ command: 'pwd', workdir: fresh });
    expect(result.success).toBe(true);
    expect(String(result.stdout)).toContain(fresh);
  });

  it('bash rejects a workdir outside $HOME', async () => {
    const result = await bash({ command: 'pwd', workdir: '/etc' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('workdir must be under');
  });

  it('upload lands relative filenames in the workdir', async () => {
    const result = await upload({
      filename: 'notes/hello.txt',
      data: Buffer.from('hi').toString('base64'),
      workdir,
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe(join(workdir, 'notes/hello.txt'));
    expect(await readFile(join(workdir, 'notes/hello.txt'), 'utf-8')).toBe('hi');
  });

  it('upload-archive extracts into targetDir', async () => {
    const src = await mkdtemp(join(tmpdir(), 'archive-src-'));
    await writeFile(join(src, 'a.txt'), 'alpha');
    const tarball = execSync(`tar czf - -C ${JSON.stringify(src)} .`);
    const target = join(workdir, 'restored');

    const result = await uploadArchive({
      data: tarball.toString('base64'),
      workdir,
      targetDir: target,
    });
    expect(result.success).toBe(true);
    expect(await readFile(join(target, 'a.txt'), 'utf-8')).toBe('alpha');
    await rm(src, { recursive: true, force: true });
  });

  it('upload-archive without targetDir extracts at the workdir root', async () => {
    const src = await mkdtemp(join(tmpdir(), 'archive-src-'));
    await writeFile(join(src, 'b.txt'), 'beta');
    const tarball = execSync(`tar czf - -C ${JSON.stringify(src)} .`);

    const result = await uploadArchive({ data: tarball.toString('base64'), workdir });
    expect(result.success).toBe(true);
    expect(await readFile(join(workdir, 'b.txt'), 'utf-8')).toBe('beta');
    await rm(src, { recursive: true, force: true });
  });

  it('download-archive honors a raised maxBytes and workdir-relative paths', async () => {
    await mkdir(join(workdir, 'big'), { recursive: true });
    // ~12 MB of random bytes: compresses over the 5 MB default cap.
    execSync(`head -c 12000000 /dev/urandom > ${JSON.stringify(join(workdir, 'big/blob.bin'))}`);

    const capped = await downloadArchive({ path: 'big', workdir });
    expect(capped.success).toBe(false);
    expect(String(capped.error)).toContain('exceeds');

    const raised = await downloadArchive({ path: 'big', workdir, maxBytes: 64 * 1024 * 1024 });
    expect(raised.success).toBe(true);
    expect(typeof raised.data).toBe('string');
  });

  it('background bash processes are reapable per workdir', async () => {
    const { reapBackground } = await import('../src/agent/tools/bash.js');
    const marker = join(workdir, 'still-alive');
    const spawned = await bash({
      command: `sleep 30 && touch ${JSON.stringify(marker)}`,
      workdir,
      run_in_background: true,
    });
    expect(spawned.success).toBe(true);

    const { killed } = reapBackground(workdir);
    expect(killed).toBe(1);
    // Killed before the sleep finished, so the marker never appears.
    await new Promise((r) => setTimeout(r, 100));
    await expect(access(marker)).rejects.toThrow();
  });

  // A command that forks a daemon and exits is behaving like a real terminal:
  // the survivor is the point. It stays running, but the group is registered so
  // the conversation's teardown still sweeps it.
  it('leaves `&` survivors of a completed command running, and reaps them at teardown', async () => {
    const { reapBackground } = await import('../src/agent/tools/bash.js');
    const marker = join(workdir, 'daemon-alive');
    const result = await bash({
      command: `(sleep 30 && touch ${JSON.stringify(marker)}) & echo forked`,
      workdir,
    });
    expect(result.success).toBe(true);
    expect(String(result.stdout)).toContain('forked');

    const { killed } = reapBackground(workdir);
    expect(killed).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    await expect(access(marker)).rejects.toThrow();
  }, 10000);

  it('interrupt kills the in-flight command; the call returns partial output', async () => {
    const { interruptForeground } = await import('../src/agent/tools/bash.js');
    const marker = join(workdir, 'never-touched');
    const pending = bash({
      command: `echo working; sleep 30; touch ${JSON.stringify(marker)}`,
      workdir,
    });
    // Let the shell start and print before interrupting.
    await new Promise((r) => setTimeout(r, 300));

    const { killed } = interruptForeground(workdir);
    expect(killed).toBe(1);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('stop request');
    expect(String(result.stdout)).toContain('working');
    expect(result.exit_code).toBe(null);
    await expect(access(marker)).rejects.toThrow();
  }, 10000);

  it('interrupt does not touch a workdir with nothing in flight', async () => {
    const { interruptForeground } = await import('../src/agent/tools/bash.js');
    expect(interruptForeground(workdir)).toEqual({ killed: 0 });
    await bash({ command: 'echo done', workdir });
    // Settled commands deregister, so a later stop finds nothing to kill.
    expect(interruptForeground(workdir)).toEqual({ killed: 0 });
  });
});

describe('laptop paired roots', () => {
  it('accepts roots outside HOME and refuses lexical and symlink escapes', async () => {
    const { runnerRoots, workspacePath } = await import('../src/agent/tools/workspace.js');
    const { symlink, realpath } = await import('node:fs/promises');
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'paired-root-')));
    try {
      const root = join(temp, 'allowed'); await mkdir(root);
      await symlink(tmpdir(), join(root, 'escape'));
      runnerRoots.run([root], () => {
        expect(resolveRoot(root)).toEqual({ ok: true, root });
        expect(resolveRoot(undefined).ok).toBe(false);
        expect(resolveRoot(temp).ok).toBe(false);
        expect(resolveRoot(join(root, '..', 'other')).ok).toBe(false);
        expect(resolveRoot(join(root, 'escape')).ok).toBe(false);
        expect(() => workspacePath('escape/file', root)).toThrow('escapes');
        expect(workspacePath('new/file', root)).toBe(join(root, 'new/file'));
      });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
