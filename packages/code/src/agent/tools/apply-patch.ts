import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, parse, sep } from 'node:path';
import { FILE_LIMIT, parsePatch, updateText, type Operation } from './patch-format.js';
import { resolveRoot, runnerSignal, workspacePath } from './workspace.js';
import { withFileMutation } from './file-mutation.js';

export interface PatchResult {
  success: boolean;
  status: 'applied' | 'rejected' | 'failed' | 'partial' | 'uncertain';
  output?: string;
  error?: string;
  applied?: string[];
  not_applied?: string[];
}
export interface PatchParams { patch: string; workdir?: string; initial_cwd?: string }
export interface PatchFS {
  read(path: string): Promise<Buffer>;
  inspect(path: string): Promise<{ mode: number; size: number; file: boolean; link: boolean; identity: string }>;
  mkdir(path: string): Promise<unknown>;
  stage(path: string, bytes: Buffer, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export const nodePatchFS: PatchFS = {
  read: path => fs.readFile(path),
  inspect: async path => {
    const s = await fs.lstat(path);
    return { mode: s.mode, size: s.size, file: s.isFile(), link: s.isSymbolicLink(), identity: `${s.dev}:${s.ino}:${s.mode}` };
  },
  mkdir: path => fs.mkdir(path, { recursive: true }),
  stage: async (path, bytes, mode) => {
    const handle = await fs.open(path, 'wx', mode & 0o777);
    try { await handle.writeFile(bytes); await handle.chmod(mode & 0o777); await handle.sync(); }
    finally { await handle.close(); }
  },
  rename: (from, to) => fs.rename(from, to),
  link: (from, to) => fs.link(from, to),
  remove: path => fs.unlink(path),
};
type Snapshot = { bytes: Buffer; mode: number; identity: string };
type Change = { op: Operation; path: string; destination?: string; before?: Snapshot; after?: Buffer };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const text = (bytes: Buffer) => {
  if (bytes.includes(0)) throw new Error('Binary files are not supported');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class PatchExecutor {
  constructor(private io: PatchFS = nodePatchFS) {}

  async run(params: PatchParams): Promise<PatchResult> {
    try { return await withFileMutation(() => this.execute(params)); }
    catch (error) { return { success: false, status: 'rejected', error: message(error) }; }
  }

  private async safe(path: string) {
    workspacePath(path);
    let current = path;
    while (current !== parse(current).root) {
      const stat = await this.io.inspect(current).catch(error => { if (missing(error)) return undefined; throw error; });
      if (stat?.link) throw new Error(`Symlinks are not supported: ${current}`);
      current = dirname(current);
    }
  }

  private async snapshot(path: string): Promise<Snapshot | undefined> {
    await this.safe(path);
    const stat = await this.io.inspect(path).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!stat) return undefined;
    if (!stat.file || stat.size > FILE_LIMIT) throw new Error(`Expected a regular text file no larger than 4 MiB: ${path}`);
    const bytes = await this.io.read(path);
    if (bytes.length > FILE_LIMIT) throw new Error(`File exceeds 4 MiB: ${path}`);
    text(bytes);
    return { bytes, mode: stat.mode, identity: stat.identity };
  }

  private async unchanged(change: Change) {
    const current = await this.snapshot(change.path);
    if (change.before ? !current || current.identity !== change.before.identity || !current.bytes.equals(change.before.bytes) : current !== undefined) {
      throw new Error(`File changed during patch execution: ${change.path}`);
    }
    if (change.destination && await this.snapshot(change.destination)) throw new Error(`Move destination exists: ${change.destination}`);
  }

  private async execute(params: PatchParams): Promise<PatchResult> {
    const root = resolveRoot(params.workdir);
    if (!root.ok) throw new Error(root.error);
    const cwd = workspacePath(params.initial_cwd ?? root.root, root.root);
    const operations = parsePatch(params.patch);
    const changes: Change[] = [];
    const targets: string[] = [];
    let size = 0;
    for (const op of operations) {
      runnerSignal.getStore()?.throwIfAborted();
      const path = workspacePath(op.path, cwd);
      const destination = op.move ? workspacePath(op.move, cwd) : undefined;
      for (const target of [path, destination].filter((p): p is string => !!p)) {
        // Refuse case aliases on platforms that commonly use case-insensitive filesystems.
        const normalized = process.platform === 'linux' ? target : target.normalize('NFC').toLowerCase();
        if (targets.some(other => normalized === other || normalized.startsWith(other + sep) || other.startsWith(normalized + sep))) throw new Error(`Conflicting patch target: ${target}`);
        targets.push(normalized);
      }
      const before = await this.snapshot(path);
      if (op.kind === 'add' ? !!before : !before) throw new Error(op.kind === 'add' ? `Add destination exists: ${path}` : `Source does not exist: ${path}`);
      if (destination && await this.snapshot(destination)) throw new Error(`Move destination exists: ${destination}`);
      const after = op.kind === 'delete' ? undefined : Buffer.from(op.kind === 'add' ? op.content! : updateText(text(before!.bytes), op.chunks));
      if (after && after.length > FILE_LIMIT) throw new Error(`Result exceeds 4 MiB: ${path}`);
      size += (before?.bytes.length ?? 0) + (after?.length ?? 0);
      if (size > 16 * 1024 * 1024) throw new Error('Patch exceeds 16 MiB total file-content budget');
      changes.push({ op, path, destination, before, after });
    }

    const applied: string[] = [];
    const staged = new Map<Change, string>();
    let mutationAttempted = false;
    let result: PatchResult;
    try {
      for (const change of changes) {
        runnerSignal.getStore()?.throwIfAborted();
        if (!change.after) continue;
        const target = change.destination ?? change.path;
        await this.io.mkdir(dirname(target));
        await this.safe(target);
        const temporary = resolve(dirname(target), `.fieldwork-patch-${randomUUID()}`);
        staged.set(change, temporary);
        await this.io.stage(temporary, change.after, change.before?.mode ?? (0o666 & ~process.umask()));
      }
      for (const change of changes) await this.unchanged(change);
      runnerSignal.getStore()?.throwIfAborted();
      // Once a commit starts, finish the batch rather than interrupt between its file operations.
      for (const change of changes) {
        await this.unchanged(change);
        mutationAttempted = true;
        if (change.op.kind === 'delete') await this.io.remove(change.path);
        else if (change.op.kind === 'add' || change.destination) {
          // Exclusive creation prevents a late destination from being overwritten.
          await this.io.link(staged.get(change)!, change.destination ?? change.path);
          if (change.destination) {
            applied.push(change.destination);
            await this.io.remove(change.path);
          }
        } else await this.io.rename(staged.get(change)!, change.path);
        applied.push(change.path);
        mutationAttempted = false;
      }
      result = {
        success: true, status: 'applied', applied,
        output: `Applied patch:\n${changes.map(c => `${c.destination ? 'move' : c.op.kind} ${c.path}${c.destination ? ` -> ${c.destination}` : ''}`).join('\n')}`,
      };
    } catch (error) {
      result = {
        success: false, status: mutationAttempted ? 'uncertain' : applied.length ? 'partial' : 'failed', applied,
        not_applied: changes.map(c => c.path).filter(path => !applied.includes(path)),
        error: message(error), output: `Completed paths: ${applied.join(', ') || 'none'}. Inspect files before retrying. Parent directories may have been created.`,
      };
    } finally {
      for (const temporary of staged.values()) await this.io.remove(temporary).catch(() => {});
    }
    return result;
  }
}
const executor = new PatchExecutor();
export const applyPatch = (params: PatchParams): Promise<PatchResult> => executor.run(params);
