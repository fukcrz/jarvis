export type SkillOrigin = "bundled" | "user" | "package" | "project";

export interface SkillEntry {
  id: string;
  name: string;
  label: string;
  description?: string;
  origin: SkillOrigin;
  /** 包名、项目名，或空。 */
  source?: string;
  enabled: boolean;
  modified: boolean;
  loaded: boolean;
  manualOnly: boolean;
  canDelete: boolean;
}

export interface SkillDiagnostic {
  message: string;
  path?: string;
}

export interface SkillSnapshot {
  bundled: SkillEntry[];
  installed: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface SkillFileListing {
  path: string;
  parent?: string;
  entries: SkillFileEntry[];
}

export interface SkillFileContent {
  path: string;
  name: string;
  content: string;
  truncated: boolean;
}
