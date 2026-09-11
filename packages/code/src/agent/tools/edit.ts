import { readFile, writeFile } from 'node:fs/promises';
import { resolveRoot, workspacePath } from './workspace.js';
import { withFileMutation } from './file-mutation.js';

interface EditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  workdir?: string;
}

export function edit(params: EditParams) { return withFileMutation(() => editUnlocked(params)); }

async function editUnlocked(params: EditParams) {
  const { file_path, old_string, new_string, replace_all, workdir } = params;
  const root = resolveRoot(workdir);
  if (!root.ok) {
    return { success: false, error: root.error };
  }
  const path = workspacePath(file_path, root.root);

  if (old_string === new_string) {
    return { success: false, error: 'old_string and new_string are identical' };
  }

  const content = await readFile(path, 'utf-8').catch(() => null);
  if (content === null) {
    return { success: false, error: `File not found: ${file_path}` };
  }

  if (!content.includes(old_string)) {
    return { success: false, error: 'old_string not found in file' };
  }

  if (replace_all) {
    const count = content.split(old_string).length - 1;
    const result = content.replaceAll(old_string, new_string);
    await writeFile(path, result, 'utf-8');
    return { success: true, output: `Replaced ${count} occurrence${count !== 1 ? 's' : ''} in ${file_path}` };
  }

  // Check for ambiguous match
  const first = content.indexOf(old_string);
  const second = content.indexOf(old_string, first + 1);
  if (second !== -1) {
    return { success: false, error: 'old_string matches multiple locations; use replace_all or provide more context' };
  }

  const result = content.replace(old_string, new_string);
  await writeFile(path, result, 'utf-8');
  return { success: true, output: `Edited ${file_path}` };
}
