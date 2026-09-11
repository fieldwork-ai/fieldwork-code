export type PatchLine = { kind: ' ' | '+' | '-'; text: string };
export type Chunk = { anchor?: string; lines: PatchLine[]; eof: boolean };
export type Operation = { kind: 'add' | 'delete' | 'update'; path: string; move?: string; content?: string; chunks: Chunk[] };
export const PATCH_LIMIT = 1024 * 1024;
export const FILE_LIMIT = 4 * 1024 * 1024;
export const FILE_COUNT_LIMIT = 100;

export function parsePatch(patch: string): Operation[] {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > PATCH_LIMIT) throw new Error('Patch must be a string of at most 1 MiB');
  let text = patch.trim();
  const wrapped = text.match(/^<<['"]?EOF['"]?\r?\n([\s\S]*)\r?\nEOF$/);
  if (wrapped) text = wrapped[1].trim();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') throw new Error('Expected *** Begin Patch and *** End Patch boundaries');
  const operations: Operation[] = [];
  let i = 1;
  const fail = (message: string): never => { throw new Error(`Invalid patch at line ${i + 1}: ${message}`); };
  const filename = (value: string) => {
    if (!value || /[\u0000-\u001f]/.test(value)) fail('invalid file path');
    return value;
  };
  while (i < lines.length - 1) {
    const header = lines[i++].trim().match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (!header) fail('expected Add, Delete, or Update File');
    const op: Operation = { kind: header![1].toLowerCase() as Operation['kind'], path: filename(header![2]), chunks: [] };
    if (op.kind === 'add') {
      const content: string[] = [];
      while (i < lines.length - 1 && !lines[i].trim().startsWith('*** ')) {
        if (!lines[i].startsWith('+')) fail('added lines must start with +');
        content.push(lines[i++].slice(1));
      }
      op.content = content.length ? content.join('\n') + '\n' : '';
    } else if (op.kind === 'update') {
      if (lines[i]?.trim().startsWith('*** Move to: ')) op.move = filename(lines[i++].trim().slice(13));
      while (i < lines.length - 1 && !lines[i].trim().startsWith('*** ')) {
        let anchor: string | undefined;
        if (lines[i] === '@@') i++;
        else if (lines[i].startsWith('@@ ')) anchor = lines[i++].slice(3);
        else if (op.chunks.length) fail('expected @@ between chunks');
        const chunk: Chunk = { anchor, lines: [], eof: false };
        while (i < lines.length - 1 && !lines[i].startsWith('@@') && !lines[i].trim().startsWith('*** ')) {
          const line = lines[i++];
          const kind = line[0];
          if (kind !== '+' && kind !== '-' && kind !== ' ') fail('expected a +, -, or space-prefixed line');
          chunk.lines.push({ kind: kind as PatchLine['kind'], text: line.slice(1) });
        }
        if (lines[i]?.trim() === '*** End of File') { chunk.eof = true; i++; }
        if (!chunk.lines.length || !chunk.lines.some(line => line.kind !== ' ')) fail('empty update chunk');
        op.chunks.push(chunk);
      }
      if (!op.chunks.length && !op.move) fail('empty update');
    }
    operations.push(op);
    if (operations.length > FILE_COUNT_LIMIT) fail('too many operations (maximum 100)');
  }
  if (!operations.length) throw new Error('Empty patch');
  return operations;
}

type Line = { text: string; ending: string };
function splitLines(text: string): Line[] {
  const result: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(re)) {
    if (!match[0]) break;
    result.push({ text: match[1], ending: match[2] });
  }
  return result;
}

export function updateText(original: string, chunks: Chunk[]): string {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = splitLines(original.slice(bom.length));
  const result: Line[] = [];
  let cursor = 0;
  const preferred = source.find(line => line.ending)?.ending || '\n';
  for (const chunk of chunks) {
    let start = cursor;
    if (chunk.anchor !== undefined) {
      const anchors = source.flatMap((line, index) => index >= cursor && line.text === chunk.anchor ? [index] : []);
      if (anchors.length !== 1) throw new Error(anchors.length ? `Ambiguous anchor: ${chunk.anchor}` : `Missing anchor: ${chunk.anchor}`);
      start = anchors[0] + 1;
    }
    const old = chunk.lines.filter(line => line.kind !== '+');
    let at: number;
    if (!old.length) at = source.length;
    else {
      const matches: number[] = [];
      for (let index = start; index <= source.length - old.length; index++) {
        if (chunk.eof && index + old.length !== source.length) continue;
        if (old.every((line, offset) => source[index + offset].text === line.text)) matches.push(index);
      }
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous hunk: provide more context' : 'Expected lines not found: reread the file and provide exact context');
      at = matches[0];
    }
    result.push(...source.slice(cursor, at));
    let index = at;
    for (const line of chunk.lines) {
      if (line.kind === ' ') result.push(source[index++]);
      else if (line.kind === '-') index++;
      else result.push({ text: line.text, ending: preferred });
    }
    cursor = at + old.length;
  }
  result.push(...source.slice(cursor));
  // Keep context bytes intact; only introduce a separator when appending after an unterminated line.
  for (let i = 0; i < result.length - 1; i++) if (!result[i].ending) result[i] = { ...result[i], ending: preferred };
  if (source.length && source.at(-1)!.ending === '' && result.length) result[result.length - 1] = { ...result.at(-1)!, ending: '' };
  return bom + result.map(line => line.text + line.ending).join('');
}
