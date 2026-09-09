import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { read } from '../src/agent/tools/read.js';
import { write } from '../src/agent/tools/write.js';
import { edit } from '../src/agent/tools/edit.js';
import { bash, liveBackgroundGroups, reapBackground } from '../src/agent/tools/bash.js';
import { WORKSPACE } from '../src/agent/tools/workspace.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'compute-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('read', () => {
  it('reads a file with line numbers', async () => {
    await writeFile(join(tmp, 'hello.txt'), 'line one\nline two\nline three');
    const result = await read({ file_path: join(tmp, 'hello.txt') });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1\tline one');
    expect(result.output).toContain('3\tline three');
  });

  it('respects offset and limit', async () => {
    await writeFile(join(tmp, 'lines.txt'), 'a\nb\nc\nd\ne');
    const result = await read({ file_path: join(tmp, 'lines.txt'), offset: 2, limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toBe('2\tb\n3\tc');
  });

  it('treats offset as 1-based (offset 1 keeps the first line)', async () => {
    await writeFile(join(tmp, 'lines.txt'), 'a\nb\nc');
    const result = await read({ file_path: join(tmp, 'lines.txt'), offset: 1, limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toBe('1\ta\n2\tb');
  });

  it('returns error for missing file', async () => {
    const result = await read({ file_path: join(tmp, 'nope.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for directory', async () => {
    const result = await read({ file_path: tmp });
    expect(result.success).toBe(false);
    expect(result.error).toContain('directory');
  });
});

/**
 * A tool result carrying a media type no provider accepts fails the turn
 * mid-stream, and the failing part is persisted — so the conversation stays
 * broken on every later turn regardless of what the user types. That is how an
 * image/svg+xml attachment permanently bricked a production conversation, and
 * `read` is the second way into the same hole. The only media types allowed out
 * of here as images are png, jpeg, gif and webp.
 */
describe('read: media types a model will accept', () => {
  it('returns SVG as text, not as an image block', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="#0a4"/></svg>';
    await writeFile(join(tmp, 'logo.svg'), svg);

    const result = await read({ file_path: join(tmp, 'logo.svg') });

    expect(result.success).toBe(true);
    expect(result.isImage).toBeFalsy();
    expect(result.mimeType).toBeUndefined();
    // The markup IS the content for an authored SVG — the model reads exact
    // colors and copy from it, which a raster would have thrown away.
    expect(String(result.output)).toContain('<rect fill="#0a4"/>');
  });

  it.each([
    ['bitmap.bmp', Buffer.from('BM', 'latin1')],
    ['favicon.ico', Buffer.from([0, 0, 1, 0])],
  ])('refuses %s rather than emitting a rejected image block', async (name, bytes) => {
    await writeFile(join(tmp, name), bytes);

    const result = await read({ file_path: join(tmp, name) });

    expect(result.isImage).toBeFalsy();
    expect(result.mimeType).toBeUndefined();
  });

  it.each([
    ['shot.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
  ])('still returns %s as an image block', async (name, mimeType) => {
    await writeFile(join(tmp, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await read({ file_path: join(tmp, name) });

    expect(result.isImage).toBe(true);
    expect(result.mimeType).toBe(mimeType);
  });
});

/**
 * Anthropic stops downscaling images and starts REJECTING them once a request
 * carries more than 20 image blocks; past that, every image in the request must
 * fit within 2000px on both edges. A read result is persisted into the message
 * row and replayed on every later turn, so one oversized screenshot read here
 * is not a failed tool call — it is a conversation that can no longer reach the
 * model. The app applies the same cap to attachments but cannot apply it to
 * these bytes, so `read` caps its own.
 */
describe('read: image dimensions the model will accept', () => {
  const sharpen = async () => (await import('sharp')).default;

  /** A real raster of the given size — sharp must be able to decode it. */
  const makePng = async (width: number, height: number) => {
    const sharp = await sharpen();
    return sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 120, b: 80 } },
    })
      .png()
      .toBuffer();
  };

  it('downscales an oversized screenshot to the many-image limit', async () => {
    // 2520x1428 is a Retina screenshot paste — the exact shape that bricked a
    // production conversation.
    await writeFile(join(tmp, 'shot.png'), await makePng(2520, 1428));

    const result = await read({ file_path: join(tmp, 'shot.png') });

    expect(result.isImage).toBe(true);
    const sharp = await sharpen();
    const { width, height } = await sharp(Buffer.from(String(result.data), 'base64')).metadata();
    expect(Math.max(width!, height!)).toBeLessThanOrEqual(2000);
    // Aspect ratio survives — the model must not be shown a distorted image.
    expect(width! / height!).toBeCloseTo(2520 / 1428, 2);
  });

  it('caps on the longest edge, not on total pixels', async () => {
    // A wide-and-short image has few pixels but still violates the rule.
    await writeFile(join(tmp, 'wide.png'), await makePng(3000, 100));

    const result = await read({ file_path: join(tmp, 'wide.png') });

    const sharp = await sharpen();
    const { width } = await sharp(Buffer.from(String(result.data), 'base64')).metadata();
    expect(width).toBe(2000);
  });

  it('returns an image already within the limit byte-for-byte', async () => {
    // No re-encode: the bytes must stay stable so the prompt prefix caches.
    const original = await makePng(800, 600);
    await writeFile(join(tmp, 'small.png'), original);

    const result = await read({ file_path: join(tmp, 'small.png') });

    expect(String(result.data)).toBe(original.toString('base64'));
  });

  it('still returns bytes it cannot decode rather than failing the read', async () => {
    // Degrading to the original reopens the many-image hazard for that one
    // image; failing the read would break every image read outright.
    await writeFile(join(tmp, 'broken.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await read({ file_path: join(tmp, 'broken.png') });

    expect(result.success).toBe(true);
    expect(result.isImage).toBe(true);
  });
});

describe('read: binary', () => {
  it('leaves PDF interpretation to the caller', async () => {
    const path = join(tmp, 'document.pdf');
    await writeFile(path, '%PDF-1.4\n');
    expect(await read({ file_path: path })).toMatchObject({ success: false, error: expect.stringContaining('binary') });
  });
  it('errors instead of returning binary bytes decoded as text', async () => {
    const path = join(tmp, 'archive.bin');
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe, 0x00]));
    const result = await read({ file_path: path });
    expect(result.success).toBe(false);
    expect(result.error).toContain('binary');
    expect(result.output).toBeUndefined();
  });

  it('still reads text that merely contains multi-byte characters', async () => {
    const path = join(tmp, 'unicode.txt');
    await writeFile(path, 'héllo — wörld\nsecond line');
    const result = await read({ file_path: path });
    expect(result.success).toBe(true);
    expect(result.output).toContain('héllo — wörld');
  });
});

describe('write', () => {
  it('writes a file and returns confirmation', async () => {
    const path = join(tmp, 'out.txt');
    const result = await write({ file_path: path, content: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('11 bytes');
    expect(await readFile(path, 'utf-8')).toBe('hello world');
  });

  it('creates parent directories', async () => {
    const path = join(tmp, 'a', 'b', 'c.txt');
    const result = await write({ file_path: path, content: 'deep' });
    expect(result.success).toBe(true);
    expect(await readFile(path, 'utf-8')).toBe('deep');
  });
});

describe('edit', () => {
  it('replaces a unique string', async () => {
    const path = join(tmp, 'edit.txt');
    await writeFile(path, 'hello world');
    const result = await edit({ file_path: path, old_string: 'world', new_string: 'earth' });
    expect(result.success).toBe(true);
    expect(await readFile(path, 'utf-8')).toBe('hello earth');
  });

  it('errors on ambiguous match without replace_all', async () => {
    const path = join(tmp, 'dup.txt');
    await writeFile(path, 'foo bar foo');
    const result = await edit({ file_path: path, old_string: 'foo', new_string: 'baz' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('multiple');
  });

  it('replace_all replaces all occurrences', async () => {
    const path = join(tmp, 'all.txt');
    await writeFile(path, 'foo bar foo');
    const result = await edit({ file_path: path, old_string: 'foo', new_string: 'baz', replace_all: true });
    expect(result.success).toBe(true);
    expect(await readFile(path, 'utf-8')).toBe('baz bar baz');
  });

  it('errors when old_string not found', async () => {
    const path = join(tmp, 'miss.txt');
    await writeFile(path, 'hello');
    const result = await edit({ file_path: path, old_string: 'xyz', new_string: 'abc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('errors when old equals new', async () => {
    const path = join(tmp, 'same.txt');
    await writeFile(path, 'hello');
    const result = await edit({ file_path: path, old_string: 'hello', new_string: 'hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('identical');
  });

  it('errors on missing file', async () => {
    const result = await edit({ file_path: join(tmp, 'nope.txt'), old_string: 'a', new_string: 'b' });
    expect(result.success).toBe(false);
  });
});

describe('bash', () => {
  it('executes a command and returns output', async () => {
    const result = await bash({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('Exit code: 0');
  });

  it('returns stdout, stderr and exit_code as separate fields', async () => {
    const result = await bash({ command: 'echo out; echo err >&2' });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exit_code).toBe(0);
  });

  it('includes stderr on nonzero exit code', async () => {
    const result = await bash({ command: 'echo err >&2; exit 1' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Exit code: 1');
    expect(result.output).toContain('Stderr: err');
    expect(result.exit_code).toBe(1);
  });

  it('times out long commands, preserving partial output', async () => {
    const result = await bash({ command: 'echo started; sleep 10', timeout: 500 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
    expect(result.error).toContain('partial output');
    expect(result.stdout).toContain('started');
  }, 10000);

  it('reports maxBuffer overflow as an output limit, not a timeout, with partial output', async () => {
    // ~11 MB of stdout against the 10 MB maxBuffer.
    const result = await bash({ command: "yes 'xxxxxxxxxxxxxxxx' | head -c 11000000; sleep 1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('output limit exceeded');
    expect(result.error).not.toContain('timeout');
    expect((result.stdout as string).length).toBeGreaterThan(0);
  }, 30000);

  // The wedge that started this: the daemon inherits the shell's stdout/stderr
  // write ends and holds them open, so waiting for pipe EOF never returns.
  it('returns as soon as the shell exits, even with a daemon holding the pipes', async () => {
    const started = Date.now();
    // The daemon outlives the shell by seconds; returning promptly is the fix.
    const result = await bash({ command: 'sleep 5 & echo forked' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('forked');
    expect(result.exit_code).toBe(0);
  }, 10000);

  it('kills the whole process group on timeout, leaving no survivors', async () => {
    const marker = join(tmp, 'survivor');
    const result = await bash({
      command: `(sleep 1 && touch ${JSON.stringify(marker)}) & echo waiting; sleep 30`,
      timeout: 300,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
    expect(result.stdout).toContain('waiting');
    // The backgrounded child was in the killed group, so it never ran.
    await new Promise((r) => setTimeout(r, 1500));
    await expect(readFile(marker)).rejects.toThrow();
  }, 10000);
});

// The fleet's freeze sweep reads this off /health to defer suspending a VM
// that still has detached work running (lifecycle.ts, BACKGROUND_GRACE_MINUTES).
describe('liveBackgroundGroups', () => {
  // Earlier cases leave survivors registered under the workspace; start clean
  // so the counts below are absolute rather than deltas.
  beforeEach(() => {
    reapBackground(WORKSPACE);
  });

  afterEach(() => {
    reapBackground(WORKSPACE);
  });

  async function waitForCount(want: number, timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let seen = liveBackgroundGroups();
    while (seen !== want && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      seen = liveBackgroundGroups();
    }
    return seen;
  }

  it('counts a running background job', async () => {
    expect(liveBackgroundGroups()).toBe(0);
    const result = await bash({ command: 'sleep 30', run_in_background: true });
    expect(result.success).toBe(true);
    expect(liveBackgroundGroups()).toBe(1);
  }, 10000);

  it('counts a survivor the foreground command backgrounded with &', async () => {
    expect(liveBackgroundGroups()).toBe(0);
    const result = await bash({ command: 'sleep 30 & echo forked' });
    expect(result.success).toBe(true);
    expect(liveBackgroundGroups()).toBe(1);
  }, 10000);

  it('prunes a job that finished on its own', async () => {
    await bash({ command: 'sleep 0.2', run_in_background: true });
    expect(liveBackgroundGroups()).toBe(1);
    // A stale pid would hold the VM warm to the ceiling every time.
    expect(await waitForCount(0)).toBe(0);
  }, 10000);

  it('drops to zero once the workdir is reaped', async () => {
    await bash({ command: 'sleep 30', run_in_background: true });
    expect(liveBackgroundGroups()).toBe(1);
    reapBackground(WORKSPACE);
    expect(await waitForCount(0)).toBe(0);
  }, 10000);
});

describe('workspacePath', () => {
  it('anchors relative paths to the workspace and passes absolute paths through', async () => {
    const { workspacePath, WORKSPACE } = await import('../src/agent/tools/workspace.js');
    expect(workspacePath('apps/x/app.json')).toBe(`${WORKSPACE}/apps/x/app.json`);
    expect(workspacePath('/tmp/abs.txt')).toBe('/tmp/abs.txt');
  });
});

/**
 * The SVG rasterizer the app drives via bash for attachments too large to send
 * as markup. Its dangerous failure mode is silent: a renderer without fonts
 * drops <text> and returns a perfectly valid PNG of the artwork with the words
 * missing, so the model confidently describes a design that has no copy on it.
 * (The Vercel gateway's own SVG rasterizer does exactly this.) Hence a fixture
 * whose entire content is one word.
 */
describe('rsvg-convert (SVG attachment rendering)', () => {
  const hasRsvg = (() => {
    try {
      execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  /** Render one SVG string the way the app does and return the PNG bytes. */
  async function render(name: string, svg: string): Promise<Buffer> {
    const src = join(tmp, `${name}.svg`);
    const out = join(tmp, `${name}.png`);
    await writeFile(src, svg);
    execFileSync('rsvg-convert', ['--background-color=white', '-w', '600', '-o', out, src]);
    return readFile(out);
  }

  const FIELD = '<rect width="600" height="200" fill="#00aa44"/>';
  const WORD =
    '<text x="300" y="120" font-family="Helvetica, Arial, sans-serif" font-size="72" ' +
    'font-weight="bold" fill="#ffffff" text-anchor="middle">PLATYPUS</text>';
  const doc = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">${body}</svg>`;

  it.skipIf(!hasRsvg)('renders text rather than silently dropping it', async () => {
    // Rendering the same field with and without the word is what makes this a
    // real assertion: a fontless renderer emits a valid PNG either way, and the
    // two are then byte-identical. Checking the PNG header alone would pass
    // against precisely the bug this exists to catch.
    const withWord = await render('marker', doc(FIELD + WORD));
    const fieldOnly = await render('field', doc(FIELD));

    expect(withWord.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(withWord.equals(fieldOnly)).toBe(false);
  });

  it.skipIf(!hasRsvg)('applies opacity rather than ignoring it', async () => {
    // The attachment that prompted this work is masked to 59% opacity, and the
    // fade IS the design — it was uploaded as a page background. A renderer
    // that ignores that returns the right picture at the wrong intensity, which
    // no PNG-header check would notice.
    const faded = await render('faded', doc('<rect width="600" height="200" fill="#000000" fill-opacity="0.59"/>'));
    const solid = await render('solid', doc('<rect width="600" height="200" fill="#000000"/>'));

    expect(faded.equals(solid)).toBe(false);
  });
});
