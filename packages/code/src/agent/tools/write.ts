import { writeFile, mkdir } from 'node:fs/promises';
import { resolveRoot, workspacePath } from './workspace.js';
import { dirname } from 'node:path';

interface WriteParams {
  file_path: string;
  content: string;
  workdir?: string;
}

export async function write(params: WriteParams) {
  const { file_path, content, workdir } = params;
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }
  const path = workspacePath(file_path, root.root);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');

  const bytes = Buffer.byteLength(content, 'utf-8');
  return { success: true, output: `Wrote ${bytes} bytes to ${file_path}` };
}
