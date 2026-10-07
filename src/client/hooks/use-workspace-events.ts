import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { workspaceEventSchema } from "../../shared/protocol";
import { socketUrl } from "../api";
import type { SessionContextMenuTarget } from "../components/session-context-menu";
import { mergeExtensionToast, type ExtensionToast, type ExtensionToastInput } from "../extension-notifications";
import { subscribeEventSocket } from "../lib/event-socket";
import { mergeSession, retainSessionListCopy, sessionKey, touchViewedIdleKeys, withoutDraft, withoutSession } from "../lib/socket-sync";

export function useWorkspaceEvents(input: {
  workspaces: Workspace[];
  deletedSessionsRef: MutableRefObject<Record<string, Set<string>>>;
  viewedIdleKeysRef: MutableRefObject<Set<string>>;
  setSessionsByWorkspace: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMenu: Dispatch<SetStateAction<SessionContextMenuTarget | undefined>>;
  setGlobalExtensionToasts: Dispatch<SetStateAction<ExtensionToast[]>>;
  onSocketReconnect?: (workspaceId: string) => void;
}): void {
  const callbacks = useRef(input);
  callbacks.current = input;
  // 名称、打开时间与排序变化不重建订阅，只有工作区集合变化才重建。
  const workspaceIdsKey = JSON.stringify(input.workspaces.map((workspace) => workspace.id).sort());
  useEffect(() => {
    const workspaceIds = JSON.parse(workspaceIdsKey) as string[];
    const cleanups = workspaceIds.map((workspaceId) => subscribeEventSocket(socketUrl(`/api/workspaces/${workspaceId}/events`), {
      onResync: () => callbacks.current.onSocketReconnect?.(workspaceId),
      onMessage: (value) => {
        const parsed = workspaceEventSchema.safeParse(value);
        if (!parsed.success || parsed.data.workspaceId !== workspaceId) return;
        const event = parsed.data;
        const { deletedSessionsRef, viewedIdleKeysRef, setSessionsByWorkspace, setDrafts, setSessionMenu, setGlobalExtensionToasts } = callbacks.current;
        if (event.type === "extension.notify") {
          const { notification } = event;
          const tone: "info" | "warning" | "error" = notification.notifyType === "warning" || notification.notifyType === "error" ? notification.notifyType : "info";
          const incoming: ExtensionToastInput = { id: notification.id, workspaceId, sessionId: notification.sessionId, message: notification.message, tone };
          setGlobalExtensionToasts((current) => {
            const merged = mergeExtensionToast(current[0], incoming);
            return merged === current[0] ? current : [merged];
          });
          return;
        }
        if (event.type === "session.deleted") {
          (deletedSessionsRef.current[workspaceId] ??= new Set()).add(event.sessionId);
          viewedIdleKeysRef.current.delete(sessionKey(workspaceId, event.sessionId));
          setSessionsByWorkspace((current) => {
            const sessions = current[workspaceId] ?? [];
            const next = withoutSession(sessions, event.sessionId);
            return next === sessions ? current : { ...current, [workspaceId]: next };
          });
          setDrafts((current) => withoutDraft(current, event.sessionId));
          setSessionMenu((current) => current?.workspaceId === workspaceId && current.session.id === event.sessionId ? undefined : current);
          return;
        }
        if (deletedSessionsRef.current[workspaceId]?.has(event.session.id) === true) return;
        touchViewedIdleKeys(viewedIdleKeysRef.current, event.session);
        setSessionsByWorkspace((current) => {
          const sessions = current[workspaceId] ?? [];
          const existing = sessions.find((session) => session.id === event.session.id);
          return { ...current, [workspaceId]: mergeSession(sessions, retainSessionListCopy(existing, event.session), viewedIdleKeysRef.current) };
        });
      },
    }));
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [workspaceIdsKey]);
}
