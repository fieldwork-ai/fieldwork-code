export interface CodexUsageWindow {
  usedPercent: number;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexUsageLimit {
  id: string;
  label: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
}

export interface CodexUsageSnapshot {
  fetchedAt: string;
  planType: string | null;
  limitReached: boolean;
  limits: CodexUsageLimit[];
}

