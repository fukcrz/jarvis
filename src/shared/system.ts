/** 数据安全相关的接口类型：配置恢复记录、回收站。 */

export interface RecoveryNotice {
  file: string;
  /** backup：已用 .bak 恢复；default：没有可用备份，已改用默认值。 */
  outcome: "backup" | "default";
  /** 坏文件被改名留存的位置。 */
  corruptPath?: string;
  reason: string;
  at: string;
}

export type TrashKind = "session" | "file";

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  /** 列表里显示的名字：会话名或文件名。 */
  label: string;
  originalPath: string;
  deletedAt: string;
  workspaceId?: string;
  sessionId?: string;
  isDirectory?: boolean;
}

export interface TrashListing {
  entries: TrashEntry[];
  retentionDays: number;
  directory: string;
}
