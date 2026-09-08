import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The file tools anchor relative paths to the workspace root, matching
 * bash's cwd — without this they'd silently resolve against the agent
 * process's cwd (/opt/agent). Absolute paths pass through unchanged.
 *
 * On the Firecracker backend one VM hosts many conversations, each in its own
 * working directory under $HOME; every request may carry a `workdir` that
 * becomes the root for that call. Requests without one — the local Docker
 * backend, and automation runs, which own their whole sandbox — keep the
 * historical $HOME root.
 */
export const runnerSignal = new AsyncLocalStorage<AbortSignal>();
export const runnerRoots = new AsyncLocalStorage<readonly string[]>();

export const WORKSPACE = process.env.HOME ?? homedir();

/** The durable tier (ADR 20260810): the user's FSx volume, NFS-mounted by the
 * guest init in user-class VMs. Never the workspace root — file churn belongs
 * on local disk — but a permitted destination for the transfer tools. */
export const USER_FILES_ROOT = '/user_files';

/**
 * Resolve a request's workdir to the effective root. Workdirs must sit under
 * $HOME: the transient tier is the only place a conversation root makes
 * sense, and anchoring one at /user_files would put every install and
 * recursive search onto NFS — the exact failure the two-tier split avoids.
 */
export function resolveRoot(
  workdir?: string,
  roots: readonly string[] = runnerRoots.getStore() ?? [WORKSPACE],
): { ok: true; root: string } | { ok: false; error: string } {
  if (!workdir) return runnerRoots.getStore() ? { ok: false, error: "workdir is required on a laptop" } : { ok: true, root: WORKSPACE };
  const target = resolve(workdir);
  if (!roots.some(root => target === resolve(root) || target.startsWith(`${resolve(root)}${sep}`))) {
    return { ok: false, error: `workdir must be under ${roots.join(" or ")}` };
  }
  if (runnerRoots.getStore() && !underRunnerRoots(target)) return { ok: false, error: "Directory escapes paired roots" };
  return { ok: true, root: target };
}

export function workspacePath(path: string, root: string = WORKSPACE): string {
  const target = resolve(root, path);
  if (runnerRoots.getStore() && !underRunnerRoots(target)) throw new Error("Path escapes paired roots");
  return target;
}

/**
 * Resolve against the root AND refuse escapes — for tools whose paths arrive
 * over the wire (uploads, archive pack/extract). Read/write/edit deliberately
 * keep plain workspacePath: the agent may touch /tmp etc., but transfer tools
 * move bytes across the platform boundary and stay bound to the transient
 * home tree or the durable /user_files tier.
 */
export function workspacePathUnder(
  path: string,
  root: string = WORKSPACE,
): { ok: true; path: string } | { ok: false; error: string } {
  const target = resolve(root, path);
  if (runnerRoots.getStore()) return underRunnerRoots(target) ? { ok: true, path: target } : { ok: false, error: "Path escapes paired roots" };
  const underHome = target === WORKSPACE || target.startsWith(`${WORKSPACE}/`);
  const underUserFiles =
    target === USER_FILES_ROOT || target.startsWith(`${USER_FILES_ROOT}/`);
  if (!underHome && !underUserFiles) {
    return { ok: false, error: `path must be under ${WORKSPACE} or ${USER_FILES_ROOT}` };
  }
  return { ok: true, path: target };
}

function underRunnerRoots(target: string): boolean {
  const roots = runnerRoots.getStore();
  if (!roots) return true;
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try {
    const real = realpathSync(ancestor);
    return roots.some(root => { const canonical = realpathSync(root); return real === canonical || real.startsWith(`${canonical}${sep}`); });
  } catch { return false; }
}
