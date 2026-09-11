import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat, open } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

export const PERSISTENT_SHELL_CAPABILITY = 'persistent-shell-v1';
const OUTPUT_LIMIT = 10 * 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export interface ShellCommand {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
  initial_cwd?: string;
  env?: Record<string, string>;
}
export interface ShellScope { manager: ShellSessionManager; key: string; root: string }
export const runnerShell = new AsyncLocalStorage<ShellScope>();

export function loginShell(): string {
  const shell = process.env.SHELL || userInfo().shell || '/bin/bash';
  if (!isAbsolute(shell) || !['zsh', 'bash'].includes(basename(shell))) {
    throw new Error(`Persistent shells do not yet support ${shell}; configure a Zsh or Bash login shell.`);
  }
  return shell;
}

interface Entry { root: string; queue: Promise<unknown>; shell?: Shell; pending: number; timer?: NodeJS.Timeout }
export class ShellSessionManager {
  private entries = new Map<string, Entry>();
  constructor(private options: { shell?: string; env?: NodeJS.ProcessEnv; idleMs?: number; startupMs?: number } = {}) {}

  execute(key: string, root: string, params: ShellCommand, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let entry = this.entries.get(key);
    if (entry && entry.root !== root) return Promise.resolve({ success: false, error: 'Shell workspace changed; close the previous session first.' });
    if (!entry) {
      entry = { root, queue: Promise.resolve(), pending: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    clearTimeout(current.timer);
    current.pending++;
    const task = current.queue.then(async () => {
      if (signal?.aborted) return { success: false, error: 'Command cancelled before execution.' };
      if (this.entries.get(key) !== current) return { success: false, error: 'Shell session closed before execution; command was not run.' };
      let created = false;
      try {
        if (!current.shell?.alive) {
          current.shell = new Shell(this.options);
          created = true;
          await current.shell.start(params.initial_cwd ?? root, signal);
        }
        const result = await current.shell.execute(params, signal);
        return { ...result, shell: current.shell.path, shell_session_id: current.shell.id,
          shell_created: created, ...(created ? { notice: 'A fresh login shell was started. Any previous shell-local state is gone; files are unchanged.' } : {}) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }).finally(() => {
      current.pending--;
      if (!current.pending && this.entries.get(key) === current) this.arm(key, current);
    });
    current.queue = task.catch(() => {});
    return task;
  }

  interrupt(key: string): number {
    const shell = this.entries.get(key)?.shell;
    if (!shell?.busy) return 0;
    shell.stop('Command interrupted; shell state was lost. The command was not replayed.');
    return 1;
  }

  dispose(key: string, reason = 'Shell session closed.'): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    clearTimeout(entry.timer);
    this.entries.delete(key);
    entry.shell?.stop(reason);
    return 1;
  }
  disposeRoot(root: string): void {
    for (const [key, entry] of this.entries) if (entry.root === root) this.dispose(key);
  }
  close(): void { for (const key of this.entries.keys()) this.dispose(key); }

  private arm(key: string, entry: Entry): void {
    entry.timer = setTimeout(() => {
      if (entry.pending || this.entries.get(key) !== entry) return;
      // Background jobs inherit the shell's process group. They hold its lease,
      // including grandchildren whose original job process has already exited.
      if (entry.shell?.hasChildren()) { this.arm(key, entry); return; }
      this.dispose(key, 'Shell expired after inactivity.');
    }, this.options.idleMs ?? 30 * 60_000);
    entry.timer.unref();
  }
}

class Shell {
  readonly id = randomUUID();
  readonly path: string;
  alive = false;
  busy = false;
  private child?: ChildProcess;
  private guardian?: ChildProcess;
  private dir = '';
  private reason = 'Shell terminated unexpectedly; command outcome is unknown. Inspect effects before retrying.';
  private pending?: { reject: (error: Error) => void };
  private startupOutput = '';
  private starting = true;
  private stopped = false;
  constructor(private options: { shell?: string; env?: NodeJS.ProcessEnv; startupMs?: number }) {
    this.path = options.shell ?? loginShell();
  }

  async start(cwd: string, signal?: AbortSignal): Promise<void> {
    this.busy = true;
    this.dir = await mkdtemp(join(tmpdir(), 'fieldwork-shell-'));
    if (this.stopped || signal?.aborted) {
      await rm(this.dir, { recursive: true, force: true });
      throw new Error('Shell startup cancelled; command was not run.');
    }
    const env = { ...process.env, ...this.options.env };
    delete env.FWCODE_TOKEN;
    const interactive = basename(this.path) !== 'sh';
    this.child = spawn(this.path, interactive ? ['-il'] : ['-l'], {
      cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;
    const capture = (chunk: Buffer) => { if (this.starting) this.startupOutput = (this.startupOutput + chunk.toString()).slice(-8192); };
    this.child.stdout!.on('data', capture);
    this.child.stderr!.on('data', capture);
    this.child.stdin!.on('error', () => {});
    this.child.on('error', error => this.died(`Shell could not start: ${error.message}`));
    this.child.on('exit', () => this.died(this.reason));
    if (this.child.pid) {
      // macOS has no parent-death signal. A separate process group watches a
      // pipe owned by the runner, so even SIGKILL of Electron reaps the shell.
      this.guardian = spawn('/bin/sh', ['-c', 'read -r reason; normal=$?; /bin/kill -KILL -- -"$1" 2>/dev/null; if [ "$normal" -ne 0 ]; then /bin/rm -rf -- "$2"; fi', 'fieldwork-shell-guardian', String(this.child.pid), this.dir], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' },
      });
      this.guardian.stdin!.on('error', () => {});
      this.guardian.on('error', () => this.stop('Shell lifecycle guardian could not start; command was not run.'));
      this.guardian.on('exit', () => { if (!this.stopped) this.stop('Shell lifecycle guardian terminated; command outcome is unknown.'); });
    }
    const abort = () => this.stop('Shell startup cancelled; command was not run.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.stop(`Login shell startup timed out; command was not run. Startup output: ${this.startupOutput}`), this.options.startupMs ?? 15_000);
    try {
      if (signal?.aborted) abort();
      // Job control off keeps descendants in the owned process group. User rc
      // files run before this handshake; prompts never serve as protocol frames.
      await this.send(`set +m\n${basename(this.path) === 'zsh' ? 'unsetopt BANG_HIST\n' : interactive ? 'set +H\n' : ''}unset HISTFILE\nPS1=''\nPS2=''\ncd -- ${quote(cwd)} || exit\n`, '0');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.starting = false;
      this.busy = false;
    }
  }

  async execute(params: ShellCommand, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.busy = true;
    const commandDir = await mkdtemp(join(this.dir, 'command-'));
    const file = (name: string) => join(commandDir, name);
    const stdoutPath = file('stdout'), stderrPath = file('stderr');
    const restore = file('restore');
    let code: number | null = null, error: string | undefined;
    const timeoutMs = Math.max(1, Math.min(params.timeout ?? 300_000, 1_800_000));
    let timer: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined;
    const abort = () => this.stop('Command interrupted; shell state was lost. The command was not replayed.');
    try {
      await writeFile(file('script'), params.command + '\n', { mode: 0o600 });
      await writeFile(stdoutPath, '', { mode: 0o600 });
      await writeFile(stderrPath, '', { mode: 0o600 });
      const entries = Object.entries(params.env ?? {});
      if (entries.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === 'FWCODE_TOKEN' || key === '__fw_status')) throw new Error('Invalid per-command environment key.');
      const save = entries.map(([key]) => `builtin printf '{\\n'; if builtin typeset -p ${key} >/dev/null 2>&1; then builtin typeset -p ${key}; else builtin printf 'builtin unset ${key}\\n'; fi; builtin printf '} || exit\\n'`).join('\n');
      const apply = entries.map(([key, value]) => `builtin export ${key}=${quote(value)} || exit`).join('\n');
      const run = `builtin . ${quote(file('script'))}`;
      const body = params.run_in_background
        ? `(\n${apply}\nbuiltin eval ${quote(params.command)}\n) >/dev/null 2>&1 </dev/null &\nbuiltin printf '%s' "$!" >${quote(file('pid'))}\n`
        : `{\n${save || ':'}\n} >${quote(restore)}\n${apply}\n{ ${run}; } >${quote(stdoutPath)} 2>${quote(stderrPath)} </dev/null\n__fw_status=$?\nbuiltin . ${quote(restore)} || exit\nbuiltin pwd -P >${quote(file('cwd'))}\n`;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => this.stop(`Command timed out after ${timeoutMs}ms; shell state was lost. Partial output returned; no replay.`), timeoutMs);
      poll = setInterval(() => {
        void Promise.all([stat(stdoutPath), stat(stderrPath)]).then(stats => {
          if (stats.some(s => s.size > OUTPUT_LIMIT)) this.stop('Output limit exceeded; shell state was lost. Narrow the command or redirect output.');
        }).catch(() => {});
      }, 25);
      code = await this.send(body, params.run_in_background ? '0' : '$__fw_status');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer); clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      this.busy = false;
    }
    const boundedRead = async (path: string) => {
      const handle = await open(path, 'r').catch(() => undefined);
      if (!handle) return '';
      try { const buffer = Buffer.alloc(OUTPUT_LIMIT); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString(); }
      finally { await handle.close(); }
    };
    const sizes = await Promise.all([stat(stdoutPath), stat(stderrPath)]).catch(() => []);
    if (!error && sizes.some(value => value.size > OUTPUT_LIMIT)) {
      error = 'Output limit exceeded; partial output returned. Shell state was lost.';
      code = null;
      this.stop(error);
    }
    const stdout = await boundedRead(stdoutPath), stderr = await boundedRead(stderrPath);
    const cwd = await readFile(file('cwd'), 'utf8').catch(() => '');
    const pid = params.run_in_background ? await readFile(file('pid'), 'utf8').catch(() => '') : '';
    await rm(commandDir, { recursive: true, force: true });
    const output = error ? `${error}\n${stdout}${stderr ? `\nStderr: ${stderr}` : ''}`
      : pid ? `Background PID: ${pid}`
      : `${stdout}\n\nExit code: ${code}${stderr ? `\nStderr: ${stderr}` : ''}`;
    return { success: !error, output, stdout: pid ? `Background PID: ${pid}` : stdout, stderr, exit_code: code, ...(error ? { error } : {}), ...(cwd ? { cwd: cwd.trimEnd() } : {}) };
  }

  hasChildren(): boolean {
    if (!this.alive || !this.child?.pid) return false;
    try {
      return execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 2000 }).split('\n').some(line => {
        const [pid, group] = line.trim().split(/\s+/).map(Number);
        return group === this.child!.pid && pid !== group;
      });
    } catch { return true; }
  }

  stop(reason: string): void {
    this.reason = reason;
    this.died(reason);
  }
  private died(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
    this.alive = false;
    this.pending?.reject(new Error(reason));
    this.pending = undefined;
    this.child?.stdin?.destroy();
    this.guardian?.stdin?.end('closed\n');
    // Do not erase files until execute has collected partial output.
    if (this.dir) { const timer = setTimeout(() => { void rm(this.dir, { recursive: true, force: true }); }, 5000); timer.unref(); }
  }
  private send(body: string, status: string): Promise<number> {
    if (!this.alive) return Promise.reject(new Error(this.reason));
    // Login Bash closes inherited nonstandard descriptors on macOS. A private
    // completion file works for both shells without parsing prompts or stdout.
    const completion = join(this.dir, `completion-${randomUUID()}`);
    return new Promise((resolve, reject) => {
      let reading = false, settled = false;
      const finish = (error?: Error, code = 0) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.pending = undefined;
        void rm(completion, { force: true });
        if (error) reject(error); else resolve(code);
      };
      const timer = setInterval(() => {
        if (reading) return;
        reading = true;
        void (async () => {
          const handle = await open(completion, 'r');
          try {
            const buffer = Buffer.alloc(32);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (settled) return;
            const text = buffer.subarray(0, bytesRead).toString();
            if (!text.endsWith('\n') && bytesRead < buffer.length) return;
            if (!/^\d{1,3}\n$/.test(text) || Number(text.trim()) > 255) { this.stop('Shell completion protocol failed; outcome unknown.'); return; }
            finish(undefined, Number(text.trim()));
          } finally { await handle.close(); }
        })().catch(() => {}).finally(() => { reading = false; });
      }, 10);
      this.pending = { reject: error => finish(error) };
      (this.child!.stdin as Writable).write(`{\n${body}\nbuiltin printf '%s\\n' "${status}" >${quote(completion)}\n}\n`);
    });
  }
}
