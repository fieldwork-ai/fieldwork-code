import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getContext } from "../http.js";
import { decodeToken } from "../config.js";
export const stateHome = () => path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state"), "fwcode");
interface DirectoryState { approved?: boolean; conversation?: string }
function filename(root: string | null) {
  const c = getContext().config;
  const identity = c.token ? decodeToken(c.token) : null;
  const key = createHash("sha256").update(JSON.stringify([c.apiUrl, identity?.sub, identity?.org ?? identity?.organization_id, root])).digest("hex");
  return path.join(stateHome(), "directories", `${key}.json`);
}
export function localState(root: string): DirectoryState {
  try { return JSON.parse(readFileSync(filename(root), "utf8")); } catch { return {}; }
}
export function saveLocalState(root: string, state: DirectoryState) {
  const file = filename(root);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, JSON.stringify(state) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function machineKey(): string {
  const file = filename(null);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomUUID();
  try { writeFileSync(file, JSON.stringify({ machine_key: key }) + "\n", { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const saved = JSON.parse(readFileSync(file, "utf8")).machine_key;
  if (typeof saved !== "string" || !/^[0-9a-f-]{36}$/.test(saved)) throw new Error("Invalid saved fwcode machine identity");
  return saved;
}
