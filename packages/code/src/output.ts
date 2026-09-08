/**
 * Output conventions (ADR 20260804): stdout carries data only, every message
 * and prompt goes to stderr, --json prints the raw API payload compact —
 * every verb honors it with a stable shape (mutations included: writes print
 * what happened, pulls print what landed where).
 * Exit codes: 0 ok · 1 server/network · 2 usage or 400 · 3 auth (401) ·
 * 4 forbidden (403) · 5 not found (404) · 6 conflict (409) · 7 rate limited.
 * Failures exit non-zero via fail()/exitCodeFor. The one deliberate
 * exception: `tool run` prints tool-error strings as data and exits 0 (chat
 * semantics — a tool error is a result, not a CLI failure); purpose verbs
 * never do that, which is one reason they are REST-backed.
 */

export const EXIT = {
  ok: 0,
  server: 1,
  usage: 2,
  auth: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
  rateLimited: 7,
} as const;

export function exitCodeFor(status: number): number {
  if (status === 400) return EXIT.usage;
  if (status === 401) return EXIT.auth;
  if (status === 403) return EXIT.forbidden;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  if (status === 429) return EXIT.rateLimited;
  return EXIT.server;
}

export function printData(value: unknown, json: boolean): void {
  if (typeof value === "string") {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface TabularResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  truncatedBy?: "rows" | "bytes" | null;
  rowsReturned?: number;
}

/** Query results: --json prints the raw payload; human mode prints TSV (a
 * header row, then rows) with any truncation noted on stderr. Truncation is
 * a successful result — no exit-code change. */
export function printTabular(result: TabularResult, json: boolean): void {
  if (json) {
    printData(result, true);
  } else {
    const cell = (v: unknown): string =>
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    const lines = [
      result.columns.join("\t"),
      ...result.rows.map((row) => result.columns.map((c) => cell(row[c])).join("\t")),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (result.truncated) {
    note(
      `truncated by ${result.truncatedBy ?? "limit"}: ${result.rowsReturned ?? result.rows.length} rows returned`,
    );
  }
}

export function fail(message: string, _code: number): never { throw new Error(message); }

/** Confirm a mutation: prompt on a TTY, --yes skips, non-TTY without --yes
 * is a usage error (unattended callers must opt in explicitly). */
export async function confirm(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail("refusing to mutate without --yes in a non-interactive session", EXIT.usage);
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      fail("aborted", EXIT.usage);
    }
  } finally {
    rl.close();
  }
}
