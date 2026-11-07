import { LOADER_STYLES, type LoaderStyle } from "../prefs/settings.ts";
import type { ThreadView } from "../types.ts";

export const AGENT_PROGRESS_INTERVAL = 180;

type SettledState = Exclude<ThreadView["state"], "starting" | "running">;

/** Built-in glyphs only; role icons are validated separately and never replaced. */
export const AGENT_LOADERS: Record<
  LoaderStyle,
  {
    label: string;
    requiresNerdFont: boolean;
    frames: readonly string[];
    states: Record<SettledState, string>;
  }
> = {
  circle: {
    label: "Circle",
    requiresNerdFont: true,
    // Nerd Fonts md-circle-slice-1..8, check-circle, pause-circle, close-circle, stop-circle.
    frames: Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0xf0a9e + index)),
    states: {
      completed: "\u{f05e0}",
      paused: "\u{f03e5}",
      failed: "\u{f0159}",
      stopped: "\u{f0666}",
    },
  },
  braille: {
    label: "Braille",
    requiresNerdFont: false,
    frames: Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"),
    states: { completed: "✓", paused: "Ⅱ", failed: "×", stopped: "■" },
  },
  hourglass: {
    label: "Hourglass",
    requiresNerdFont: true,
    // Nerd Fonts fa-hourglass-start/half/end, check-square, pause, times-circle, stop.
    frames: ["\uf251", "\uf252", "\uf253"],
    states: { completed: "\uf14a", paused: "\uf04c", failed: "\uf057", stopped: "\uf04d" },
  },
  // Compact ASCII palettes inspired by cli-spinners line, star2 and toggle13.
  // https://github.com/sindresorhus/cli-spinners/blob/main/spinners.json
  ascii: {
    label: "ASCII",
    requiresNerdFont: false,
    frames: ["|", "/", "-", "\\"],
    states: { completed: "+", paused: "=", failed: "!", stopped: "#" },
  },
  "ascii-star": {
    label: "ASCII Star",
    requiresNerdFont: false,
    frames: ["+", "x", "*"],
    states: { completed: "+", paused: "=", failed: "!", stopped: "#" },
  },
  "ascii-pulse": {
    label: "ASCII Pulse",
    requiresNerdFont: false,
    frames: ["=", "*", "-"],
    states: { completed: "+", paused: "=", failed: "!", stopped: "#" },
  },
};

/** Filter the picker without exposing private-use glyphs to ordinary fonts. */
export function availableLoaderStyles(nerdFontIcons: boolean): LoaderStyle[] {
  return LOADER_STYLES.filter((style) => nerdFontIcons || !AGENT_LOADERS[style].requiresNerdFont);
}

/** Preserve saved preferences, but render a portable fallback when Nerd Fonts are off. */
export function effectiveLoaderStyle(style: LoaderStyle, nerdFontIcons: boolean): LoaderStyle {
  return !nerdFontIcons && AGENT_LOADERS[style].requiresNerdFont ? "ascii" : style;
}

/** RPC/non-animated hosts use the first running frame and all settled indicators. */
export function agentProgressIcon(
  thread: Pick<ThreadView, "state">,
  nerdFontIcons: boolean,
  now = Date.now(),
  animate = true,
  loaderStyle: LoaderStyle = "circle",
): string | undefined {
  const loader = AGENT_LOADERS[effectiveLoaderStyle(loaderStyle, nerdFontIcons)];
  if (thread.state === "starting" || thread.state === "running") {
    const index = animate ? Math.floor(Math.max(0, now) / AGENT_PROGRESS_INTERVAL) : 0;
    return loader.frames[index % loader.frames.length];
  }
  return loader.states[thread.state];
}

/** Restrict the separate label prefix to trusted, single built-in loader glyphs. */
export function isAgentLoaderGlyph(glyph: string, nerdFontIcons = true): boolean {
  return Object.values(AGENT_LOADERS).some(
    (loader) =>
      (nerdFontIcons || !loader.requiresNerdFont) &&
      (loader.frames.includes(glyph) || Object.values(loader.states).includes(glyph)),
  );
}
