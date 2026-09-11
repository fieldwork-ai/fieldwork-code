import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PatchExecutor } from '../src/agent/tools/apply-patch.js';
import { runnerRoots } from '../src/agent/tools/workspace.js';

const fixtures = fileURLToPath(new URL('./fixtures/codex-patch/', import.meta.url));
const names = (await readdir(fixtures, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
const rejected = new Set(['005', '006', '007', '008', '009', '012', '013']);
// Intentional divergences: no overwrites; preflight catches a missing later file before an earlier add.
const rejectedByPolicy = new Set(['010', '011', '015']);

async function snapshot(root: string): Promise<Record<string, Buffer>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const result: Record<string, Buffer> = {};
  for (const entry of entries) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name);
    result[path.slice(root.length + 1).replaceAll('\\', '/')] = await readFile(path);
  }
  return result;
}

describe('pinned Codex fixture contract (no Codex executable)', () => {
  for (const name of names) it(name, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fieldwork-codex-contract-')));
    try {
      const input = join(fixtures, name, 'input');
      if (await stat(input).catch(() => undefined)) await cp(input, root, { recursive: true });
      const before = await snapshot(root);
      const patch = await readFile(join(fixtures, name, 'patch.txt'), 'utf8');
      const result = await runnerRoots.run([root], () => new PatchExecutor().run({ patch, workdir: root }));
      const id = name.slice(0, 3);
      const fails = rejected.has(id) || rejectedByPolicy.has(id);
      expect(result.success, result.error).toBe(!fails);
      const expected = rejectedByPolicy.has(id) ? before : await snapshot(join(fixtures, name, 'expected'));
      expect(await snapshot(root)).toEqual(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
