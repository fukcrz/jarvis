import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QueuedMessage, SessionQueue } from "../shared/protocol.js";
import { userContentFromContent } from "./projection.js";
import { queuedMessage } from "./session-helpers.js";

type Agent = AgentSession["agent"];
type AgentMessage = Parameters<Agent["steer"]>[0];
type QueueKind = QueuedMessage["kind"];

interface QueueEntry {
  kind: QueueKind;
  item?: QueuedMessage;
  message: AgentMessage;
}

/** Pi 的文字镜像不含附件；在完整消息进入底层队列时记录，投递时按消息身份移除。 */
export class SessionMessageQueue {
  private entries: QueueEntry[] = [];
  private suspended = false;
  private replayEntry: QueueEntry | undefined;
  private readonly detach: () => void;

  constructor(private readonly session: AgentSession, private readonly onChange: (queue: SessionQueue) => void) {
    const agent = session.agent;
    const steer = agent.steer;
    const followUp = agent.followUp;
    const clearSteering = agent.clearSteeringQueue;
    const clearFollowUp = agent.clearFollowUpQueue;
    const clearAll = agent.clearAllQueues;
    const steeringQueue = (agent as unknown as { steeringQueue?: { drain: () => AgentMessage[] } }).steeringQueue;
    const followUpQueue = (agent as unknown as { followUpQueue?: { drain: () => AgentMessage[] } }).followUpQueue;
    const steerDrain = steeringQueue?.drain;
    const followUpDrain = followUpQueue?.drain;
    const trackedSteer: Agent["steer"] = (message) => {
      steer.call(agent, message);
      this.capture("steer", message);
    };
    const trackedFollowUp: Agent["followUp"] = (message) => {
      followUp.call(agent, message);
      this.capture("followUp", message);
    };
    const trackedClearSteering = () => {
      clearSteering.call(agent);
      this.clear("steer");
    };
    const trackedClearFollowUp = () => {
      clearFollowUp.call(agent);
      this.clear("followUp");
    };
    const trackedClearAll = () => {
      clearAll.call(agent);
      this.entries = [];
      this.publish();
    };
    agent.steer = trackedSteer;
    agent.followUp = trackedFollowUp;
    agent.clearSteeringQueue = trackedClearSteering;
    agent.clearFollowUpQueue = trackedClearFollowUp;
    agent.clearAllQueues = trackedClearAll;
    const trackedSteerDrain = steerDrain === undefined ? undefined : () => {
      const messages = steerDrain.call(steeringQueue);
      this.claim(messages);
      return messages;
    };
    const trackedFollowUpDrain = followUpDrain === undefined ? undefined : () => {
      const messages = followUpDrain.call(followUpQueue);
      this.claim(messages);
      return messages;
    };
    if (steeringQueue !== undefined && trackedSteerDrain !== undefined) steeringQueue.drain = trackedSteerDrain;
    if (followUpQueue !== undefined && trackedFollowUpDrain !== undefined) followUpQueue.drain = trackedFollowUpDrain;
    const unsubscribe = agent.subscribe((event) => {
      if (event.type !== "message_start") return;
      const index = this.entries.findIndex((entry) => entry.message === event.message);
      if (index === -1) return;
      const [entry] = this.entries.splice(index, 1);
      // AgentSession removes non-empty user text from its own mirror. Pure-image
      // messages have an empty text mirror, so remove that stale entry here too.
      if (entry?.message.role === "user") this.removeEmptyMirror(entry.kind, entry.message);
      this.publish();
    });
    this.detach = () => {
      unsubscribe();
      if (agent.steer === trackedSteer) agent.steer = steer;
      if (agent.followUp === trackedFollowUp) agent.followUp = followUp;
      if (agent.clearSteeringQueue === trackedClearSteering) agent.clearSteeringQueue = clearSteering;
      if (agent.clearFollowUpQueue === trackedClearFollowUp) agent.clearFollowUpQueue = clearFollowUp;
      if (agent.clearAllQueues === trackedClearAll) agent.clearAllQueues = clearAll;
      if (steeringQueue !== undefined && trackedSteerDrain !== undefined && steeringQueue.drain === trackedSteerDrain) steeringQueue.drain = steerDrain!;
      if (followUpQueue !== undefined && trackedFollowUpDrain !== undefined && followUpQueue.drain === trackedFollowUpDrain) followUpQueue.drain = followUpDrain!;
    };
  }

  snapshot(): SessionQueue {
    return {
      steering: this.entries.flatMap((entry) => entry.item !== undefined && entry.kind === "steer" ? [entry.item] : []),
      followUp: this.entries.flatMap((entry) => entry.item !== undefined && entry.kind === "followUp" ? [entry.item] : []),
    };
  }

  takeAll(): SessionQueue {
    const removed = this.snapshot();
    const custom = this.entries.filter((entry) => entry.item === undefined);
    this.suspended = true;
    try {
      this.session.clearQueue();
      for (const entry of custom) {
        this.replayEntry = entry;
        if (entry.kind === "steer") this.session.agent.steer(entry.message);
        else this.session.agent.followUp(entry.message);
      }
    } finally {
      this.replayEntry = undefined;
      this.suspended = false;
      this.publish();
    }
    return removed;
  }

  async remove(messageId: string, kind?: QueueKind): Promise<QueuedMessage | undefined> {
    const target = this.entries.find((entry) => entry.item?.id === messageId);
    if (target?.item === undefined || target.kind === kind) return target?.item;
    const updated = kind === undefined ? undefined : { ...target.item, kind };
    const remaining = this.entries.filter((entry) => entry !== target);
    const replay: QueueEntry[] = updated === undefined
      ? remaining
      : [...remaining, { ...target, kind: updated.kind, item: updated }];
    this.suspended = true;
    try {
      this.session.clearQueue();
      // 用户消息走 SDK 已处理过输入的内部入队方法，恢复其 mirror；扩展
      // custom 消息直接复用完整消息，避免删除/切换时把它一并丢掉。
      for (const queueKind of ["steer", "followUp"] as const) {
        for (const entry of replay.filter((candidate) => candidate.kind === queueKind)) {
          this.replayEntry = entry;
          this.requeue(entry, queueKind);
        }
      }
    } finally {
      this.replayEntry = undefined;
      this.suspended = false;
      this.publish();
    }
    return updated ?? target.item;
  }

  dispose(): void {
    this.detach();
    this.entries = [];
  }

  private claim(messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    const claimed = new Set(messages);
    const removed = this.entries.filter((entry) => claimed.has(entry.message));
    if (removed.length === 0) return;
    // Pi's SDK removes textual queue mirrors at message_start. Empty-text image
    // messages have no corresponding removal, so close that gap at drain time.
    for (const entry of removed) {
      if (entry.message.role === "user") this.removeEmptyMirror(entry.kind, entry.message);
    }
    this.entries = this.entries.filter((entry) => !claimed.has(entry.message));
    this.publish();
  }

  private capture(kind: QueueKind, message: AgentMessage): void {
    if (this.replayEntry !== undefined) {
      this.entries.push({ ...this.replayEntry, kind, message });
      this.publish();
      return;
    }
    if (message.role !== "user") {
      this.entries.push({ kind, message });
      return;
    }
    const { text, images } = userContentFromContent(message.content);
    this.entries.push({ kind, item: queuedMessage(kind, text, images), message });
    this.publish();
  }

  private clear(kind: QueueKind): void {
    this.entries = this.entries.filter((entry) => entry.kind !== kind);
    this.publish();
  }

  private requeue(entry: QueueEntry, kind: QueueKind): void {
    if (entry.message.role === "user") {
      const { text, images } = userContentFromContent(entry.message.content);
      const content = images.flatMap((image) => image.data === undefined ? [] : [{ type: "image" as const, data: image.data, mimeType: image.mimeType }]);
      const session = this.session as unknown as {
        _queueSteer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
        _queueFollowUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
      };
      // Pi 1.0.2 performs this private enqueue synchronously despite the
      // Promise return type; keeping the replay synchronous prevents two queue
      // edits from interleaving between clear and requeue.
      if (kind === "steer") void session._queueSteer(text, content);
      else void session._queueFollowUp(text, content);
      return;
    }
    if (kind === "steer") this.session.agent.steer(entry.message);
    else this.session.agent.followUp(entry.message);
  }

  private removeEmptyMirror(kind: QueueKind, message: AgentMessage): void {
    if (message.role !== "user") return;
    const { text } = userContentFromContent(message.content);
    if (text !== "") return;
    const session = this.session as unknown as { _steeringMessages?: string[]; _followUpMessages?: string[] };
    const mirror = kind === "steer" ? session._steeringMessages : session._followUpMessages;
    const index = mirror?.indexOf("") ?? -1;
    if (index !== -1) mirror?.splice(index, 1);
  }

  private publish(): void {
    if (!this.suspended) this.onChange(this.snapshot());
  }
}
