import { read } from './tools/read.js';
import { write } from './tools/write.js';
import { edit } from './tools/edit.js';
import { applyPatch } from './tools/apply-patch.js';
import { bash, interruptForeground, reapBackground } from './tools/bash.js';
import { upload } from './tools/upload.js';
import { uploadToS3 } from './tools/upload-to-s3.js';
import { uploadArchive } from './tools/upload-archive.js';
import { downloadArchive } from './tools/download-archive.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (params: any) => Promise<Record<string, unknown>>;

export const routes: Record<string, Handler> = {
  'POST /read': read,
  'POST /write': write,
  'POST /edit': edit,
  'POST /apply-patch': async params => ({ ...await applyPatch(params) }),
  'POST /capabilities': async () => ({ success: true, capabilities: ['apply-patch-v1'] }),
  'POST /bash': bash,
  'POST /upload': upload,
  'POST /upload-to-s3': uploadToS3,
  'POST /upload-archive': uploadArchive,
  'POST /download-archive': downloadArchive,
  'POST /reap': async (params: { workdir?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' };
    return { success: true, ...reapBackground(params.workdir) };
  },
  // A user stop that landed while a command was still running. Kills only the
  // in-flight foreground group — daemons earlier calls left running are the
  // conversation's, not this turn's, and are swept by /reap at teardown.
  'POST /interrupt': async (params: { workdir?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' };
    return { success: true, ...interruptForeground(params.workdir) };
  },
};
