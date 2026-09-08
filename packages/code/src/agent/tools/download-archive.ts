import { stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { resolveRoot, workspacePathUnder } from './workspace.js';

interface DownloadArchiveParams {
  path: string; // directory to tar, relative to the workspace (or absolute under it)
  workdir?: string;
  /** Raise the compressed-size cap for large transfers (the share-time
   * workdir fork). Clamped to MAX_REQUESTABLE_BYTES. */
  maxBytes?: number;
}

const DEFAULT_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_REQUESTABLE_BYTES = 512 * 1024 * 1024;

/**
 * The reverse of upload-archive: tar.gz a directory and return it base64.
 * Added for app_deploy (APP-26) — the platform pulls the authored bundle out
 * of the container exactly once, at deploy time. Also the export half of the
 * share-time conversation fork (ADR 20260810).
 */
export async function downloadArchive(params: DownloadArchiveParams): Promise<Record<string, unknown>> {
  const { path, workdir, maxBytes } = params;
  if (!path) {
    return { success: false, error: 'path is required' };
  }
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }

  const resolved = workspacePathUnder(path, root.root);
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  const target = resolved.path;
  const maxArchiveBytes = Math.min(
    maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    MAX_REQUESTABLE_BYTES,
  );

  let stats;
  try {
    stats = await stat(target);
  } catch {
    return { success: false, error: `no such directory: ${path}` };
  }
  if (!stats.isDirectory()) {
    return { success: false, error: `not a directory: ${path}` };
  }

  // -C into the target so archive paths are relative to the bundle root.
  let archive: Buffer;
  try {
    archive = execSync(`tar czf - -C ${JSON.stringify(target)} .`, {
      maxBuffer: maxArchiveBytes + 1024,
      timeout: 300_000,
    });
  } catch (err) {
    // execSync reports maxBuffer overflow as ENOBUFS (exec uses
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER); accept both.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { success: false, error: `directory exceeds ${maxArchiveBytes} bytes archived` };
    }
    throw err;
  }
  if (archive.length > maxArchiveBytes) {
    return { success: false, error: `directory exceeds ${maxArchiveBytes} bytes archived` };
  }

  const listing = execSync(`tar tzf - `, { input: archive, encoding: 'utf-8', timeout: 10_000 });
  const fileCount = listing
    .trim()
    .split('\n')
    .filter((l) => l && !l.endsWith('/')).length;

  return { success: true, data: archive.toString('base64'), fileCount };
}
