import type { FileChange } from "../../shared/protocol";

/** "+12 −3"，数值为 0 的一侧不显示。 */
export function DiffStat({ added, removed, className = "" }: { added: number; removed: number; className?: string }) {
  if (added === 0 && removed === 0) return null;
  return <span className={`diff-stat ${className}`.trim()} aria-label={`新增 ${String(added)} 行，删除 ${String(removed)} 行`}>
    {added === 0 ? null : <span className="diff-stat-added">+{added}</span>}
    {removed === 0 ? null : <span className="diff-stat-removed">−{removed}</span>}
  </span>;
}

/** 按行着色的 diff：新增绿、删除红，"@@" 作为段落分隔。 */
export function DiffView({ change }: { change: FileChange }) {
  const lines = (change.diff ?? "").split("\n");
  if (change.diff === undefined || change.diff === "") return <div className="diff-view-empty">没有可展示的改动内容</div>;
  return <div className="diff-view" role="region" aria-label={`${change.path} 的改动`}>
    <pre>{lines.map((line, index) => {
      if (line.startsWith("@@")) return index === 0 ? null : <span key={index} className="diff-line hunk" aria-hidden>⋯</span>;
      const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
      return <span key={index} className={`diff-line ${kind}`}><span className="diff-sign" aria-hidden>{kind === "added" ? "+" : kind === "removed" ? "−" : " "}</span>{line.slice(1) || " "}</span>;
    })}</pre>
    {change.truncated === true ? <div className="diff-view-truncated">改动太长，只显示前一部分</div> : null}
  </div>;
}
