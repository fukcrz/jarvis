import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { settingsCategory } from "../lib/settings-registry";
import { normalizeSearchText, searchSettings, type SettingsSearchEntry } from "../lib/settings-search";

/** ⌘ 或 Ctrl，按平台显示。 */
export function modKeyLabel(): string {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

function highlight(text: string, query: string): ReactNode {
  const tokens = normalizeSearchText(query).split(" ").filter((token) => token !== "");
  if (tokens.length === 0) return text;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0) marks.push([index, index + token.length]);
  }
  if (marks.length === 0) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  marks.forEach(([start, end], index) => {
    if (start < cursor) return;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  parts.push(text.slice(cursor));
  return parts;
}

/** 设置搜索面板（Ctrl+K）：↑↓ 选择，回车跳转并高亮对应设置项。 */
export function SettingsSearchPalette({ open, entries, onClose, onPick }: {
  open: boolean;
  entries: readonly SettingsSearchEntry[];
  onClose: () => void;
  onPick: (entry: SettingsSearchEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchSettings(entries, query, query.trim() === "" ? 8 : 30), [entries, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(".st-pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;
  const pick = (entry: SettingsSearchEntry | undefined) => { if (entry !== undefined) onPick(entry); };
  return <div className="st-pal-back" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="st-pal" role="dialog" aria-modal="true" aria-label="搜索设置">
      <div className="st-pal-in">
        <Search size={16} />
        <input ref={inputRef} value={query} placeholder="搜索设置、供应商、模型、插件、工作区…" aria-label="搜索设置" aria-controls="st-pal-list"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected((index) => Math.min(index + 1, results.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); pick(results[selected]); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          }} />
        <kbd className="st-kbd">Esc</kbd>
      </div>
      <div className="st-pal-list" id="st-pal-list" ref={listRef} role="listbox">
        {results.length === 0 ? <div className="st-empty">没有找到「{query.trim()}」相关的设置</div> : results.map((entry, index) => {
          const category = settingsCategory(entry.category);
          const Icon = category.icon;
          return <button type="button" key={entry.key} role="option" aria-selected={index === selected} className={`st-pal-item${index === selected ? " sel" : ""}`}
            onMouseMove={() => { if (index !== selected) setSelected(index); }} onClick={() => pick(entry)}>
            <Icon size={15} />
            <span className="st-pal-text"><b>{highlight(entry.title, query)}</b>{entry.description === undefined ? null : <small>{highlight(entry.description, query)}</small>}</span>
            <span className="st-pal-where">{category.title}</span>
          </button>;
        })}
      </div>
      <div className="st-pal-foot"><span>↑↓ 选择</span><span>回车 跳转并高亮</span><span>支持同义词：密码/认证、穿透/公网、beta/测试版</span></div>
    </div>
  </div>;
}
