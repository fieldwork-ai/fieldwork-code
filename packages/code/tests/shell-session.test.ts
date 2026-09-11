import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ShellSessionManager } from '../src/agent/tools/shell-session.js';

const managers: ShellSessionManager[] = [];
const dirs: string[] = [];
async function makeFixture(options: { idleMs?: number; startupMs?: number } = {}, shell = '/bin/bash') {
  const root = await mkdtemp(join(tmpdir(), 'fw-shell-test-')); dirs.push(root);
  await writeFile(join(root, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), `export BOOTED=yes\nprintf x >> '${root}/boots'\n`);
  await writeFile(join(root, '.bash_profile'), `. '${root}/.bashrc'\n`);
  const manager = new ShellSessionManager({ shell, env: { HOME: root, ZDOTDIR: root }, ...options }); managers.push(manager);
  return { root, manager, run: (command: string, extra = {}) => manager.execute('one', root, { command, ...extra }) };
}
afterEach(async () => { for (const manager of managers.splice(0)) manager.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32').each(process.platform === 'darwin' ? ['/bin/zsh', '/bin/bash'] : ['/bin/bash'])('persistent login shell %s', shell => {
  const fixture = (options: { idleMs?: number; startupMs?: number } = {}) => makeFixture(options, shell);
  it('loads rc once and retains variables, functions, aliases and cwd', async () => {
    const { run, root } = await fixture();
    const first = await run(`export SAVED=value\nhello() { printf hello; }\nalias greeting='printf alias'\nmkdir child\ncd child`);
    expect(first.success).toBe(true);
    const second = await run(`printf '%s:%s:' "$BOOTED" "$SAVED"; hello; greeting; pwd; cat ../boots`);
    expect(second.stdout).toBe(`yes:value:helloalias${root}/child\nx`);
    expect(second.shell_session_id).toBe(first.shell_session_id);
    expect(second.shell_created).toBe(false);
  });
  it('serializes concurrent commands and isolates conversations sharing a directory', async () => {
    const { run, root, manager } = await fixture();
    const [a, b] = await Promise.all([run('sleep 0.05; export VALUE=one'), run('printf %s "$VALUE"')]);
    expect(b.stdout).toBe('one'); expect(b.shell_session_id).toBe(a.shell_session_id);
    expect((await manager.execute('two', root, { command: 'printf %s "${VALUE-unset}"' })).stdout).toBe('unset');
  });
  it('returns nonzero and syntax errors without confusing output with framing', async () => {
    const { run } = await fixture();
    expect((await run('printf fake-marker; printf error >&2; false')).exit_code).toBe(1);
    const bad = await run('if then');
    expect(bad.exit_code).not.toBe(0);
    expect((await run('printf recovered')).stdout).toBe('recovered');
  });
  it('restores per-command environment without rolling back intentional shell changes', async () => {
    const { run } = await fixture();
    await run('export EXISTING=old');
    const result = await run('printf "%s:%s" "$TEMP_SECRET" "$EXISTING"; export KEPT=yes', { env: { TEMP_SECRET: 'secret', EXISTING: 'new' } });
    expect(result.stdout).toBe('secret:new');
    expect((await run('printf "%s:%s:%s" "${TEMP_SECRET-unset}" "$EXISTING" "$KEPT"')).stdout).toBe('unset:old:yes');
  });
  it('retires the shell rather than leak an environment override that cannot be restored', async () => {
    const { run } = await fixture();
    const result = await run('readonly TEMP_SECRET', { env: { TEMP_SECRET: 'secret', ANOTHER: 'value' } });
    expect(result.success).toBe(false);
    const next = await run('printf %s "${TEMP_SECRET-unset}"');
    expect(next.stdout).toBe('unset');
    expect(next.shell_created).toBe(true);
  });

  it('reports death with partial output, does not replay, and recreates on the next command', async () => {
    const { run } = await fixture();
    const dead = await run('printf once >> effects; printf partial; kill -KILL $$');
    expect(dead.success).toBe(false); expect(dead.stdout).toBe('partial');
    const next = await run('cat effects');
    expect(next.stdout).toBe('once'); expect(next.shell_created).toBe(true);
    expect(next.shell_session_id).not.toBe(dead.shell_session_id);
  });
  it('times out and then recreates, without timing out queued commands before they start', async () => {
    const { run } = await fixture();
    const timed = await run('printf partial; sleep 10', { timeout: 50 });
    expect(timed.success).toBe(false); expect(timed.stdout).toBe('partial');
    expect(String(timed.error)).toContain('timed out');
    expect((await run('printf next')).stdout).toBe('next');
  });
  it('expires only idle shells and reenters cleanly', async () => {
    const { run } = await fixture({ idleMs: 30 });
    const first = await run('sleep 0.1; export LOST=yes');
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = await run('printf %s "${LOST-unset}"');
    expect(next.stdout).toBe('unset'); expect(next.shell_session_id).not.toBe(first.shell_session_id);
  });
  it('keeps shells with background jobs alive and cancels only its conversation', async () => {
    const { run, root, manager } = await fixture({ idleMs: 30 });
    const first = await run('sleep 0.3', { run_in_background: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await run('printf alive')).shell_session_id).toBe(first.shell_session_id);
    const other = await manager.execute('other', root, { command: 'export VALUE=safe; sleep 0.3 &' });
    const pending = run('sleep 10');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(manager.interrupt('one')).toBe(1);
    expect((await pending).success).toBe(false);
    expect((await manager.execute('other', root, { command: 'printf %s "$VALUE"' })).shell_session_id).toBe(other.shell_session_id);
  });
  it('reaps a detached shell when its runner is killed without cleanup', async () => {
    const { root } = await fixture();
    const source = new URL('../src/agent/tools/shell-session.ts', import.meta.url).href;
    const program = `import { ShellSessionManager } from ${JSON.stringify(source)};
      const manager = new ShellSessionManager({ shell: ${JSON.stringify(shell)}, env: { HOME: ${JSON.stringify(root)}, ZDOTDIR: ${JSON.stringify(root)} } });
      console.log(JSON.stringify(await manager.execute('crash', ${JSON.stringify(root)}, {command: 'printf "%s" "$$"'})));`;
    const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    host.stdout.on('data', chunk => { output += chunk; });
    host.stderr.on('data', chunk => { errors += chunk; });
    try {
      await vi.waitFor(() => expect(output, errors).toContain('\n'), { timeout: 3000 });
      const result = JSON.parse(output.trim());
      expect(result.success).toBe(true);
      const pid = Number(result.stdout);
      expect(pid, JSON.stringify(result)).toBeGreaterThan(0);
      const exited = once(host, 'exit');
      host.kill('SIGKILL');
      await exited;
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
    } finally { host.kill('SIGKILL'); }
  });

  it('does not execute a cancelled queued command', async () => {
    const { root, manager, run } = await fixture();
    const first = run('sleep 0.1');
    const abort = new AbortController();
    const queued = manager.execute('one', root, { command: 'export MUST_NOT_RUN=yes' }, abort.signal);
    abort.abort();
    await first;
    expect(await queued).toMatchObject({ success: false, error: expect.stringContaining('before execution') });
    expect((await run('printf %s "${MUST_NOT_RUN-unset}"')).stdout).toBe('unset');
  });

  it('bounds output even when the command finishes before the size poll', async () => {
    const { run } = await fixture();
    const result = await run(`'${process.execPath}' -e 'process.stdout.write("x".repeat(11000000))'`);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Output limit');
    expect(String(result.stdout).length).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect((await run('printf recovered')).stdout).toBe('recovered');
  });

  it('bounds startup and does not run commands after startup fails', async () => {
    const { run, root } = await fixture({ startupMs: 50 });
    await writeFile(join(root, '.zshrc'), 'sleep 10\n');
    await writeFile(join(root, '.bashrc'), 'sleep 10\n');
    const result = await run('touch should-not-exist');
    expect(result.success).toBe(false); expect(String(result.error)).toContain('startup timed out');
  });
});
