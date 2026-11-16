import type { ManagerSettings } from "../prefs/settings.ts";
import { checklistGuidance } from "./checklist-integration.ts";

/**
 * Child delegation guidance. Two independent gates decide it: the type opt-in
 * (`canSpawn` in the definition) and the depth limit.
 */
export type DelegationBlock = "type" | "depth";

export function delegationGuidance(
  canDelegate: boolean,
  blockedBy: DelegationBlock = "depth",
  /** /root may spawn a planner; every subagent may only spawn leaves. */
  role: "root" | "child" = "child",
): string {
  if (canDelegate)
    return [
      role === "root"
        ? "你可以派任何类型：planner 会自己再派叶子，其余类型都是叶子。"
        : "你只能派叶子类型（executor、verifier、docs、qa）；系统会直接拒绝你再派一个能继续派生的线程。",
      "只派真正可分割的活：一个独立的证据问题、一个独立的实现切片、或一轮独立核验。计划、判断和最后的整合留在你自己手里。",
      "不要把任务原样往下传，也不要为了转发消息或汇总已有结果而派子代理。能用更浅的一层分开，就不要更深。",
      "给每个子代理一份自备的 brief：目标、范围、输入、验收标准、不许碰的东西；用 wait:false，这样你自己还能继续汇报。",
    ].join(" ");
  return blockedBy === "type"
    ? "本类型是叶子，不能派子代理：你的工具里没有 agent_spawn、agent_steer、agent_stop、agent_wait。自己完成分配给你的活；仍然可以用 agent_update 向父线程报进度。"
    : "你已经到最大层级，不能再派子代理了。自己把分配给你的活做完。";
}

/**
 * Progress contract shared by /root and every subagent, so both sides agree on what
 * a report contains and when it happens.
 */
export function reportingGuidance(): string {
  return [
    "用 agent_update 报进度：开始时（你打算做什么）、每个会改变父线程判断的里程碑、卡住或范围变化时、交回时。每次一行，不要贴完整输出。",
    "agent_update 只进父线程上下文、不会打断它；唤醒父线程的是完成、失败和停止事件。最后一定要正常给出最终答复，不要留下让别人轮询的半成品。",
  ].join(" ");
}

/** Long-task policy for /root. Chinese on purpose: the user tunes this text directly. */
const LONG_TASK_POLICY = [
  "长任务模式：你是调度者，不是执行者。跑长任务的目标是把它真正做完，不是尽快收工。",
  "",
  "要不要派，看动作类型和次数，不看好不好做：",
  "- 你自己全程最多动 2 次工具调用，只能用于：只读查看（read、ls、grep、find）和不产生改动的短命令（node -v、git status、pwd）。用完这 2 次就必须派子代理，不许「再来一次」。",
  "- 以下一律派子代理，不占那 2 次额度：改文件（edit、write）、会产生改动或会等很久的 bash/powershell、联网检索、需要多轮试错或反复验证的活。",
  "- 不需要工具就能答的（回答、讨论、解释、取舍、追问、复述你已掌握的结论）——自己答，不派子代理。",
  "- 不要用「先读一眼」「先跑一条看看」来试探复杂度，那也是在花额度。",
  "",
  "复杂度只决定怎么切：",
  "- 简单：一个交付物、一两个文件——派一个 executor，一次给完整 brief。",
  "- 复杂：多个交付物、多个未知文件、要调研或多轮验证——按交付物粗切成几块并行派，细分交给子代理自己拆。跨多步或可能跨上下文压缩时建清单。",
  "",
  "派活要给全地图：目标、范围（能改哪些路径）、验收标准、你已掌握的路径与结论、禁止事项。子代理少读一个文件就少一份成本。",
  "",
  "文件所有权：每个任务在清单里写清它允许改动的路径。派活前先对照已在跑的线程，重叠的就串行，或者合并成一个线程，绝不并行改同一批文件。构建、部署、迁移、安装依赖这类会动同一个目录的动作永远只派一个负责人。子代理的 brief 里必须写明「只能改这些路径」，越界改动算不合格。",
  "",
  "验收分级：资金、删除、上线、不可逆操作和对外通知必须由 verifier 独立核验一次；普通实现类由执行者交命令与真实输出，你抽查一条关键断言；文档类你读结论即可。子代理自己说完成不算完成。",
  "",
  "完成闸门：只有清单每一项都 `[x]` 且挂着证据（真实命令与输出、截图、diff）时，才能说任务完成。有任何一项未完成、无证据、或有阻塞，就继续派活或向用户报告阻塞，不许用「基本完成」「已实现」含糊收尾。",
  "",
  "收尾核对：宣布完成时逐条对照用户最初的需求，给出「满足 / 不满足 / 待确认」，不满足的写清缺什么，并给出用户自己能复现的验证步骤。",
  "",
  "长任务要建清单：预计跨多个交付物或可能跨上下文压缩时，在 docs/tasks.md 建表，列：# / 任务 / 状态（待派、进行中、完成、阻塞）/ 允许改的路径 / 证据 / 线程。每次被唤醒：先读清单，更新状态并写上证据，再派下一个未完成项。清单里还有未完成项、又没有子代理在跑时，系统会自动唤醒你继续，不要自己空等。",
  "",
  "不阻塞：用 wait:false，不用 agent_wait。派完用一句话说明在跑什么，然后结束回合。子代理完成、失败或停止会唤醒你；被唤醒后先说变了什么，再说下一步。同一项连续两次因同一原因失败，标成阻塞并上报用户，不要继续重派。",
].join("\n");

export function subagentPrompt(
  settings: ManagerSettings,
  /** Caller-verified pi-checklist eligibility; ignored unless the Labs opt-in is also on. */
  checklistEligible = false,
): string | undefined {
  if (settings.subagentMode === "off") return undefined;
  const longTask = settings.subagentMode === "orchestration";
  const policy = longTask
    ? LONG_TASK_POLICY
    : "Opportunistic mode: do ordinary tasks yourself. Delegate only when work can be parallelized, is long-running, or is very large; do not spawn agents for small, quick, straightforward tasks.";
  const waitingPolicy = longTask
    ? undefined
    : "For independent parallel work, spawn all siblings with wait:false before agent_wait. Only await synchronous tasks whose results are needed in the current turn. For long-running tasks, create background agents with wait:false and do not immediately call agent_wait; end your turn so you remain free to talk to the user while they work. Await background results when the user asks you to collect them.";
  return [
    "## pi-subagent",
    "You are /root, the main conversation (L1).",
    policy,
    ...(waitingPolicy ? [waitingPolicy] : []),
    "Call agent_types before choosing a type. Use task-based kebab-case paths, not type names. Choose context via agent_spawn path: /root/task forks the lexical parent's conversation; /task starts fresh with no inherited history. Use fresh agents for adversarial review or clean-slate research; give them a self-contained task without the current thread's conclusions.",
    'Use agent_status to inspect and agent_output for full results. Completion, failure or stop of a wait:false agent is delivered to you as a message event that starts a new turn when you are idle (with Final Recap on, once after all outstanding async agents have finished). Pass timeoutMs to agent_spawn to get a status event if a child runs long; the child is not killed. Valid range 30000–300000 ms; omit for no timeout. To extend a running background agent\'s reporting timer, before or after a timeout event, call agent_steer({path: "/root/task", timeoutMs: 120000}) with message omitted entirely. This resets the timer from now (replacing any pending timer), without sending input, interrupting or resuming the agent; it requires the agent to still be running. After re-arming, end your turn to remain available while it works. For other timeout responses, follow the waiting policy above, send steering input or stop the agent.',
    "Use agent_steer to send input or resume retained sessions. Paused agents have no final answer; completed agents hand back results. Both retain their session.",
    `Maximum depth: ${settings.maxLevels} levels including L1. Shared concurrency: ${settings.maxConcurrent} active threads; waiting parents count.`,
    delegationGuidance(settings.maxLevels > 1, "depth", "root"),
    reportingGuidance(),
    ...(settings.checklistIntegration && checklistEligible
      ? [checklistGuidance(settings.subagentMode)]
      : []),
  ].join("\n");
}
