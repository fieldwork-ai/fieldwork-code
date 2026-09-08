import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRoot, workspacePathUnder } from './workspace.js';

interface UploadArchiveParams {
  data: string; // base64-encoded tar.gz
  workdir?: string;
  /** Extraction target (default: the effective root). Skills, app bundles,
   * and connector adapters land per-conversation instead of stomping $HOME. */
  targetDir?: string;
}

export async function uploadArchive(params: UploadArchiveParams): Promise<Record<string, unknown>> {
  const { data, workdir, targetDir } = params;

  if (!data) {
    return { success: false, error: 'data is required' };
  }
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }
  const target = workspacePathUnder(targetDir ?? '.', root.root);
  if (!target.ok) {
    return { success: false, error: target.error };
  }

  const buf = Buffer.from(data, 'base64');

  // Write to a temp file, extract to the target, then clean up
  const tmpDir = await mkdtemp(join(tmpdir(), 'archive-'));
  const archivePath = join(tmpDir, 'archive.tar.gz');

  try {
    await writeFile(archivePath, buf);
    await mkdir(target.path, { recursive: true });

    execSync(
      `tar xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(target.path)}`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    // Count extracted files
    const listing = execSync(
      `tar tzf ${JSON.stringify(archivePath)}`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const files = listing.trim().split('\n').filter((l) => !l.endsWith('/'));

    return {
      success: true,
      filesExtracted: files.length,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
