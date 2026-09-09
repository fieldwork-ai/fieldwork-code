import { readFile } from 'node:fs/promises';
import { resolveRoot, workspacePath } from './workspace.js';

interface UploadToS3Params {
  filePath: string;
  uploadUrl: string;
  contentType: string;
  workdir?: string;
}

export async function uploadToS3(params: UploadToS3Params): Promise<Record<string, unknown>> {
  const { filePath, uploadUrl, contentType, workdir } = params;

  if (!filePath || !uploadUrl || !contentType) {
    return { success: false, error: 'filePath, uploadUrl, and contentType are required' };
  }
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }

  const data = await readFile(workspacePath(filePath, root.root));

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: data,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    return {
      success: false,
      error: `S3 upload failed: ${res.status} ${res.statusText}`,
    };
  }

  return {
    success: true,
    sizeBytes: data.length,
  };
}
