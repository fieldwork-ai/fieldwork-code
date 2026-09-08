import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { resolveRoot, workspacePath } from './workspace.js';


// Exactly the media types a model will accept as an image block. Every provider
// enumerates this set and 400s on anything else, and a tool result carrying a
// rejected block fails the turn mid-stream — so svg, bmp and ico must NOT be
// here even though they are images. SVG falls through to the text arm below,
// which is what you want anyway: the markup is the content.
//
// The app keeps the same set in MODEL_IMAGE_MIMES (src/lib/ai/history.ts) and
// cannot share it across the package boundary — keep the two in sync.
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Anthropic stops downscaling images and starts REJECTING them once a request
// carries more than 20 image blocks, and every block in the request must then
// be within this limit. A read result is persisted into the message row and
// replayed on every later turn, so one oversized screenshot read here is not a
// failed tool call — it is a conversation that can no longer reach the model.
//
// The app applies the same limit to attachments (MANY_IMAGE_MAX_EDGE_PX,
// src/lib/ai/providers.ts) but cannot apply it here: it never sees these bytes
// until they are already in the result, and it deliberately carries no image
// codec. So the cap is unconditional on this side. Losing detail above 2000px
// costs nothing real — the provider downscales past that anyway.
const IMAGE_MAX_EDGE = 2000;

interface ReadParams {
  file_path: string;
  offset?: number;
  limit?: number;
  workdir?: string;
}

/**
 * Shrink an image to IMAGE_MAX_EDGE if it is larger, preserving aspect ratio.
 *
 * `rotate()` with no argument applies the EXIF orientation before resizing. It
 * is load-bearing, not cosmetic: sharp drops metadata on write, so without it a
 * photo carrying an orientation tag would reach the model rotated.
 *
 * Best-effort, matching how the app treats its own staging-time render: if
 * sharp cannot load or the image cannot be decoded, the original bytes are
 * returned rather than failing the read. That reopens the many-image hazard for
 * that one image, which is strictly better than making image reads fail.
 *
 * Animated GIFs are left alone — resizing one means deciding what happens to
 * the animation, and sharp flattens to the first frame by default.
 */
async function downscaleForModel(buffer: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === 'image/gif') return buffer;
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(buffer, { failOn: 'none' });
    const { width, height } = await image.metadata();
    if (!width || !height || Math.max(width, height) <= IMAGE_MAX_EDGE) return buffer;
    return await image
      .rotate()
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  } catch (err) {
    console.error('Image not downscaled for the model:', err);
    return buffer;
  }
}

/**
 * Text never contains NUL. This is the heuristic git uses to classify a blob
 * as binary, and it is what stops an unrecognized binary being decoded as
 * UTF-8 and returned as line-numbered mojibake — a silent `success: true`
 * that burns the context window and tells the model nothing.
 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

export async function read(params: ReadParams): Promise<Record<string, unknown>> {
  const { file_path, offset, limit, workdir } = params;
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }
  const path = workspacePath(file_path, root.root);

  const info = await stat(path).catch(() => null);
  if (!info) {
    return { success: false, error: `File not found: ${file_path}` };
  }
  if (info.isDirectory()) {
    return { success: false, error: `Path is a directory: ${file_path}` };
  }

  const ext = extname(path).toLowerCase();
  const mimeType = IMAGE_EXTENSIONS[ext];

  if (mimeType) {
    const buffer = await downscaleForModel(await readFile(path), mimeType);
    const data = buffer.toString('base64');
    return { success: true, isImage: true, data, mimeType };
  }

  const buffer = await readFile(path);
  if (ext === '.pdf' || looksBinary(buffer)) {
    return {
      success: false,
      error: `Cannot read ${basename(path)} as text: it is a binary file. Convert it first (pdftotext, markitdown, unzip) or inspect it with bash (file, xxd).`,
    };
  }
  const raw = buffer.toString('utf-8');
  const lines = raw.split('\n');

  // offset is 1-based per the tool contract (see builtin.ts), so line 1 maps to
  // array index 0. Treating it as a raw 0-based index dropped the first line and
  // made every offset read start one line late.
  const start = offset != null ? Math.max(0, offset - 1) : 0;
  const end = limit != null ? start + limit : lines.length;
  const sliced = lines.slice(start, end);

  const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

  return { success: true, output: numbered };
}
