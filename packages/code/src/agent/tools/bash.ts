import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolveRoot, WORKSPACE, runnerSignal } from './workspace.js';
import { runnerShell } from './shell-session.js';

interface BashParams {
  command: string;
  shell_session?: boolean;
  initial_cwd?: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
  workdir?: string;
  /** Extra env merged over the agent's process env for this call (carries the
   * per-conversation CLI credentials on the Firecracker backend). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 300_000;
const MAX_TIMEOUT = 1_800_000;
const MAX_BUFFER = 10 * 1024 * 1024;
/** How long after the shell exits we wait for its pipes to drain before
 * answering with what we have. Only reached when something the command
 * backgrounded still holds the write ends. */
const FLUSH_GRACE_MS = 100;

/**
 * Background process groups by workdir, so a conversation's teardown can reap
 * what its turns left running (POST /reap). In-memory on purpose: a VM
 * freeze/resume preserves this process with its children, and a host roll
 * kills everything anyway.
 */
const backgroundGroups = new Map<string, Set<number>>();

/** A foreground command still running, keyed by workdir so POST /interrupt can
 * kill exactly the command a stopped turn has in flight — and nothing a
 * previous, already-returned call left behind. */
interface ForegroundRun {
  pid: number;
  /** SIGKILL the whole group; returns false if it was already gone. */
  interrupt: () => boolean;
}
const foregroundGroups = new Map<string, Set<ForegroundRun>>();

/** Kill whatever foreground command(s) this workdir has in flight. Each killed
 * shell's `exit` fires, so its /bash request returns normally with the partial
 * output plus a stop marker rather than hanging or 500ing. */
export function interruptForeground(workdir: string): { killed: number } {
  const scope = runnerShell.getStore();
  const shellKilled = scope?.manager.interrupt(scope.key) ?? 0;
  const root = resolveRoot(workdir);
  const key = root.ok ? root.root : workdir;
  const runs = foregroundGroups.get(key);
  let killed = shellKilled;
  if (runs) {
    for (const run of runs) {
      if (run.interrupt()) killed++;
    }
  }
  return { killed };
}

/**
 * How many background process groups are still alive, pruning the ones that
 * are not. The fleet's freeze sweep reads this off /health to defer freezing a
 * VM whose conversation left work running — `activeRequests` cannot see it,
 * because a backgrounded command's /bash request returned long ago.
 *
 * Probing the negated pid asks about the whole process group, so a job that
 * forked or exec'd still counts — the count means what reapBackground would
 * kill, not what we happened to spawn. Pruning here is the only place dead
 * groups leave the map: registration has no exit hook, and a stale pid would
 * otherwise hold a VM warm forever (and make /reap signal corpses).
 */
export function liveBackgroundGroups(): number {
  let live = 0;
  for (const [key, pids] of backgroundGroups) {
    for (const pid of pids) {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, 0);
        live++;
      } catch {
        pids.delete(pid);
      }
    }
    if (pids.size === 0) backgroundGroups.delete(key);
  }
  return live;
}

export function reapBackground(workdir: string): { killed: number } {
  const scope = runnerShell.getStore();
  const shellKilled = scope?.manager.dispose(scope.key) ?? 0;
  const root = resolveRoot(workdir);
  const key = root.ok ? root.root : workdir;
  const pids = backgroundGroups.get(key);
  let killed = shellKilled;
  if (pids) {
    for (const pid of pids) {
      try {
        killProcessGroup(pid);
        killed++;
      } catch {
        // already gone
      }
    }
    backgroundGroups.delete(key);
  }
  return { killed };
}

/**
 * Legacy concatenated form. Kept byte-identical because the app's
 * tool-connector executor, the datalake orchestrator, and the chat UI all
 * parse the "\n\nExit code: N[\nStderr: ...]" framing out of `output`.
 * Newer app code prefers the separate stdout/stderr/exit_code fields.
 */
function legacyOutput(stdout: string, stderr: string, exitCode: number): string {
  let output = stdout || '';
  output += `\n\nExit code: ${exitCode}`;
  if (stderr) {
    output += `\nStderr: ${stderr}`;
  }
  return output;
}

export async function bash(params: BashParams) {
  const { command, timeout, run_in_background, workdir, env } = params;

  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }
  const cwd = root.root;
  if (params.shell_session) {
    const scope = runnerShell.getStore();
    if (!scope || scope.root !== cwd) return { success: false, error: 'Persistent shell is unavailable on this executor; command was not run.' };
    const initial = resolveRoot(params.initial_cwd ?? cwd);
    if (!initial.ok) return { success: false, error: initial.error };
    return scope.manager.execute(scope.key, cwd, { ...params, initial_cwd: initial.root }, runnerSignal.getStore());
  }
  // Conversation workdirs are created lazily by their first command.
  if (cwd !== WORKSPACE) {
    await mkdir(cwd, { recursive: true });
  }
  const signal = runnerSignal.getStore();
  if (signal?.aborted) return { success: false, error: "Terminal session interrupted" };
  const childEnv = env || signal ? { ...process.env, ...env } : process.env;
  if (signal) delete childEnv.FWCODE_TOKEN;

  if (run_in_background) {
    const child = spawn('bash', ['-c', command], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: childEnv,
    });
    child.unref();
    if (child.pid) {
      let group = backgroundGroups.get(cwd);
      if (!group) {
        group = new Set();
        backgroundGroups.set(cwd, group);
      }
      group.add(child.pid);
    }
    return { success: true, output: `Background PID: ${child.pid}` };
  }

  const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

  return new Promise<Record<string, unknown>>((resolve) => {
    // `detached` puts the command in its own process group, which is what makes
    // a timeout or a stop able to kill the whole tree rather than just the
    // shell. stdin is ignored so nothing can block waiting to read it.
    const child = spawn('bash', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: childEnv,
    });
    const pid = child.pid;

    let stdout = '';
    let stderr = '';
    let settled = false;
    /** Why we are ending, when it isn't the command's own exit. */
    let ending: 'timeout' | 'overflow' | 'interrupt' | null = null;

    const killGroup = (): boolean => {
      if (pid === undefined) return false;
      try {
        killProcessGroup(pid);
        return true;
      } catch {
        return false; // already gone
      }
    };

    const run: ForegroundRun = {
      pid: pid ?? -1,
      interrupt: () => {
        ending ??= 'interrupt';
        return killGroup();
      },
    };
    let group: Set<ForegroundRun> | undefined;
    if (pid !== undefined) {
      group = foregroundGroups.get(cwd);
      if (!group) {
        group = new Set();
        foregroundGroups.set(cwd, group);
      }
      group.add(run);
    }

    const onAbort = () => { run.interrupt(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      ending = 'timeout';
      killGroup();
    }, effectiveTimeout);

    const capture = (stream: NodeJS.ReadableStream, which: 'out' | 'err') => {
      stream.on('data', (chunk: Buffer) => {
        if (which === 'out') stdout += chunk.toString();
        else stderr += chunk.toString();
        // Overflow is distinct from a timeout on purpose: an overflow reported
        // as "timeout" sends the model retrying with a longer timeout, which
        // can never succeed.
        if (!ending && (stdout.length > MAX_BUFFER || stderr.length > MAX_BUFFER)) {
          ending = 'overflow';
          killGroup();
        }
      });
      stream.on('error', () => {});
    };
    capture(child.stdout, 'out');
    capture(child.stderr, 'err');

    const drain = (stream: NodeJS.ReadableStream) => {
      stream.removeAllListeners('data');
      stream.resume();
    };

    const settle = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (group) {
        group.delete(run);
        if (group.size === 0) foregroundGroups.delete(cwd);
      }
      // Stop accumulating, but do NOT destroy: a survivor still holds the write
      // end, and closing our read end would SIGPIPE it on its next write — the
      // opposite of leaving it running. Draining discards what it writes and
      // closes naturally when it finally exits.
      drain(child.stdout);
      drain(child.stderr);
      resolve(result);
    };

    child.on('error', (err) => {
      settle({ success: false, error: err.message, stdout, stderr, exit_code: null });
    });

    // Resolve on `exit` (the shell is gone), never on `close` (all pipes shut).
    // A grandchild the command backgrounded with `&` inherits the stdout/stderr
    // write ends and holds them open for its whole life, so `close` may never
    // fire — that is the wedge this replaced. `close` is still preferred when it
    // arrives promptly, because it means every last byte has been read.
    child.on('exit', (code, signal) => {
      const finish = () => {
        const out = stdout.slice(0, MAX_BUFFER);
        const err = stderr.slice(0, MAX_BUFFER);

        if (ending === 'overflow') {
          settle({
            success: false,
            error: `output limit exceeded (${MAX_BUFFER / (1024 * 1024)} MB); partial output returned. Narrow the command (head/tail/rg) or redirect to a file and read it selectively.`,
            stdout: out,
            stderr: err,
            exit_code: null,
          });
          return;
        }
        if (ending === 'timeout') {
          settle({
            success: false,
            error: `timeout after ${Math.round(effectiveTimeout / 1000)}s; partial output returned`,
            stdout: out,
            stderr: err,
            exit_code: null,
          });
          return;
        }
        if (ending === 'interrupt') {
          settle({
            success: false,
            error: 'killed by stop request; partial output returned',
            stdout: out,
            stderr: err,
            exit_code: null,
          });
          return;
        }
        if (code === null) {
          settle({
            success: false,
            error: `terminated by signal ${signal}; partial output returned`,
            stdout: out,
            stderr: err,
            exit_code: null,
          });
          return;
        }

        // The command exited on its own. Anything it backgrounded with `&` is
        // deliberately left running — that is what a real terminal does and
        // what the model asked for — but the group is registered so the
        // conversation's teardown reap still sweeps it.
        if (pid !== undefined) {
          try {
            process.kill(process.platform === "win32" ? pid : -pid, 0);
            let orphans = backgroundGroups.get(cwd);
            if (!orphans) {
              orphans = new Set();
              backgroundGroups.set(cwd, orphans);
            }
            orphans.add(pid);
          } catch {
            // group empty: nothing survived the command
          }
        }

        settle({
          success: true,
          output: legacyOutput(out, err, code),
          stdout: out,
          stderr: err,
          exit_code: code,
        });
      };

      // Give the pipes a bounded moment to deliver whatever the command wrote
      // just before exiting; `close` short-circuits it when no survivor is
      // holding the write ends.
      const flush = setTimeout(finish, FLUSH_GRACE_MS);
      flush.unref?.();
      child.once('close', () => {
        clearTimeout(flush);
        finish();
      });
    });
  });
}

function killProcessGroup(pid: number): void {
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(-pid, "SIGKILL");
}
