/** Aggregated provider-reported usage. `reasoning` is already included in `output`. */
export interface UsageBucket {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
  pricedCalls: number;
}

export interface UsageModelRow extends UsageBucket {
  provider: string;
  model: string;
}

export interface UsageProviderRow extends UsageBucket {
  provider: string;
}

export interface UsageDayRow extends UsageBucket {
  day: string;
  /** The provider with the most tokens that day. Unnamed providers lose to a named one. */
  topProvider?: string;
  /** How many distinct providers were used. */
  models: number;
}

export interface UsageWorkspaceRow extends UsageBucket {
  workspaceId: string;
  label: string;
}

export type UsageRange = "today" | "thisWeek" | "thisMonth" | "lastWeek" | "lastMonth" | "thisYear" | "all";

export interface UsageStats {
  generatedAt: string;
  range: UsageRange;
  /** Set when the totals, providers, and models cover one workspace. The workspace list stays complete. */
  workspaceId?: string;
  sessions: number;
  unreadable: number;
  totals: UsageBucket;
  byProvider: UsageProviderRow[];
  byModel: UsageModelRow[];
  byDay: UsageDayRow[];
  byWorkspace: UsageWorkspaceRow[];
}
