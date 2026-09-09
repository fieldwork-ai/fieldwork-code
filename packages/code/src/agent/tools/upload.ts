import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { resolveRoot, workspacePathUnder } from './workspace.js';

interface UploadParams {
  filename: string;
  data: string; // base64-encoded
  workdir?: string;
}

export async function upload(params: UploadParams): Promise<Record<string, unknown>> {
  const { filename, data, workdir } = params;

  if (!filename) {
    return { success: false, error: 'filename is required' };
  }
  if (!data) {
    return { success: false, error: 'data is required' };
  }
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }

  const buf = Buffer.from(data, 'base64');
  // workspacePathUnder (unlike the old join) also refuses ../ escapes.
  const resolved = workspacePathUnder(filename, root.root);
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  let targetPath = resolved.path;

  // Create parent directories if needed
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  // Handle filename conflicts
  if (existsSync(targetPath)) {
    const ext = extname(filename);
    const base = basename(filename, ext);
    let counter = 1;
    while (existsSync(targetPath)) {
      targetPath = join(dir, `${base}-${counter}${ext}`);
      counter++;
    }
  }

  await writeFile(targetPath, buf);

  return {
    success: true,
    path: targetPath,
    sizeBytes: buf.length,
  };
}
