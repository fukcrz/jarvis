export interface BundledPluginStatus {
  id: string;
  label: string;
  enabled: boolean;
  modified: boolean;
}

export interface RecommendedPluginStatus {
  name: string;
  source: string;
  enabled: boolean;
  installed: boolean;
}

export interface InstalledPluginStatus {
  source: string;
  name: string;
  version?: string;
}

export interface PluginSnapshot {
  bundled: BundledPluginStatus[];
  recommended: RecommendedPluginStatus[];
  installed: InstalledPluginStatus[];
}

export interface PluginCatalogItem {
  name: string;
  version: string;
  description: string;
  source: string;
  installed: boolean;
  /** GitHub 仓库地址优先，否则是 npm 页面。 */
  url: string;
}

export interface ModelGroupRoute {
  provider: string;
  model: string;
  recommendedConcurrency?: number;
  [key: string]: unknown;
}

export interface ModelGroup {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap?: Record<string, string | null>;
  routes: ModelGroupRoute[];
  [key: string]: unknown;
}

export interface ModelGroupsConfig {
  version: number;
  retry?: { groupRetryDelayMs?: number; [key: string]: unknown };
  compaction?: { thresholdTokens?: number; reserveTokens?: number; [key: string]: unknown };
  groups: Record<string, ModelGroup>;
  [key: string]: unknown;
}

export interface ModelGroupsSnapshot {
  enabled: boolean;
  path: string;
  exists: boolean;
  revision: string;
  config: ModelGroupsConfig;
  error?: string;
}

export interface BundledPluginLifecycle {
  assertReady?: () => void;
  reload?: () => Promise<number>;
  withReload?: <T>(operation: (reload: () => Promise<number>) => Promise<T>) => Promise<T>;
}
