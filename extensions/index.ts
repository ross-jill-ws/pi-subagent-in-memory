/**
 * pi-subagent-in-memory — In-process subagent tool for pi.
 *
 * Registers a `subagent_create` tool that spawns subagent sessions in the same
 * process via the pi SDK's createAgentSession. Live progress is streamed back
 * as tool_execution_update events and rendered as TUI card widgets.
 *
 * Key design principle: apart from tool parameter definitions, this extension
 * adds NOTHING to your LLM context. No system prompt injection, no hidden
 * instructions — the LLM only sees the tool schema.
 *
 * Features:
 * - Live TUI card widgets showing subagent status and output
 * - JSONL event logging to ~/.pi/subagent-in-memory/<sessionId>/
 * - Nested subagent support (subagents can spawn subagents)
 * - `subagent_kill` tool to stop a stuck subagent before its timeout expires
 * - Slash commands to control TUI overlay:
 *     /saim-toggle-overlay [on|off]   — enable/disable rendering
 *     /saim-set-max-tui-overlays <N>  — limit visible cards (1-9)
 *     /saim-clear-tui-overlay         — clear all cards & close any overlay
 * - Runtime limits (each also available as a CLI flag):
 *     /saim-max-depth [n]             — max subagent nesting depth (default 2)
 *     /saim-timeout [seconds]         — default subagent timeout (default 1800s,
 *                                       0 = unlimited)
 * - Parent aborts/timeouts do NOT kill running children: the child detaches,
 *   keeps running under its own timeout, and still writes result.md /
 *   error.md (plus partial-result.md salvaging any text produced so far).
 * - Multi-provider support (Anthropic, OpenAI, Google, etc.)
 * - Configurable keys to inspect subagent prompt & live messages
 *   (Ctrl+Shift+<N> by default) and to page through cards when there are
 *   more subagents than the visible window allows (Ctrl+Alt+Left/Right by
 *   default). Both are set in <agent dir>/subagent-in-memory.json; see
 *   extensions/config.ts.
 * - --saim-no-tui CLI flag to start with the overlay disabled
 *
 * Results are written to ./.pi/subagent-in-memory/<mainSessionId>/subagent_<N>/result.md
 * (or error.md on failure) so the calling agent gets a short pointer instead of
 * the full output.
 */

import { Type, type Static } from "typebox";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderCard, type CardTheme } from "./tui-draw.ts";
import { inspectKeyId, keyLabel, loadKeysConfig, modifierLabel } from "./config.ts";

import { visibleWidth, truncateToWidth, wrapTextWithAnsi, matchesKey } from "@earendil-works/pi-tui";
import type { Focusable } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── JSONL event logger ──────────────────────────────────────────
const jsonlWriteQueues = new Map<string, Promise<void>>();

function jsonlAppend(filePath: string, data: Record<string, any>) {
  const line = JSON.stringify(data) + "\n";
  const prev = jsonlWriteQueues.get(filePath) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => appendFile(filePath, line, "utf-8"));
  jsonlWriteQueues.set(filePath, next);
  return next;
}

async function flushJsonl(filePath: string) {
  const pending = jsonlWriteQueues.get(filePath);
  if (!pending) return;
  try {
    await pending;
  } catch {
    // Best-effort logging; tool execution should not fail because log flushing failed.
  } finally {
    if (jsonlWriteQueues.get(filePath) === pending) {
      jsonlWriteQueues.delete(filePath);
    }
  }
}

// ── Subagent card state ─────────────────────────────────────────
interface SubagentCard {
  num: number;
  sessionId: string;
  title: string;
  modelLabel: string;
  status: "created" | "running" | "completed" | "error";
  prompt: string;
  messages: string;
  columnWidthPercent: number;
  startedAt: number;
  endedAt?: number;
}

const CARD_THEMES: CardTheme[] = [
  { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m" },
  { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m" },
  { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m" },
  { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m" },
  { bg: "\x1b[48;2;55;50;10m",  br: "\x1b[38;2;190;170;50m" },
  { bg: "\x1b[48;2;15;55;30m",  br: "\x1b[38;2;50;185;100m" },
];

const MAX_CARD_MESSAGE_CHARS = 16_000;
const MAX_PARTIAL_UPDATE_CHARS = 4_000;
const PARTIAL_UPDATE_INTERVAL_MS = 200;
const WIDGET_ANIMATION_INTERVAL_MS = 500;

function formatElapsed(startedAt: number, endedAt?: number): string {
  const elapsed = Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function hasActiveSubagents() {
  return subagents.some((sa) => sa.status === "running" || sa.status === "created");
}

function trimCardMessages(card: SubagentCard) {
  if (card.messages.length <= MAX_CARD_MESSAGE_CHARS) return;
  let trimmed = card.messages.slice(-MAX_CARD_MESSAGE_CHARS);
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline >= 0) {
    trimmed = trimmed.slice(firstNewline + 1);
  }
  card.messages = `…\n${trimmed}`;
}

function appendMessage(card: SubagentCard, msg: string) {
  card.messages += (card.messages ? "\n" : "") + msg;
  trimCardMessages(card);
}

function appendMessageChunk(card: SubagentCard, chunk: string) {
  card.messages += chunk;
  trimCardMessages(card);
}

/** Tail of the card's activity stream, used to make result.md/error.md
 * self-describing when the subagent produced little or no final text. */
function activityTail(card: SubagentCard, maxChars = 2_000): string {
  const text = card.messages.trim();
  if (!text) return "(no recorded activity)";
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

// ── Shared state — single instance across all nesting levels ────
const subagents: SubagentCard[] = [];

/** A subagent that is still executing (including one that detached after its
 * parent aborted). Registered as soon as the run starts and removed once
 * result.md / error.md has been written, so `subagent_kill` only ever sees
 * subagents it can actually stop. */
interface RunningSubagent {
  card: SubagentCard;
  outDir: string;
  /** Nesting depth of this subagent (1 = spawned by the main agent). */
  depth: number;
  /** Aborts the session and fails the run. Returns false if it already ended. */
  kill: (reason: string) => boolean;
}
const runningSubagents = new Map<string, RunningSubagent>();

let currentCtx: { ui: any } | null = null;
let mainSessionId = "unknown";
let subagentCount = 0;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let widgetTui: any = null;
let widgetMounted = false;
let widgetRenderVersion = 0;

// Track open detail overlay so we can trigger re-renders
let activeDetailTui: any = null;
let activeDetailDone: ((result: void) => void) | null = null;

// ── Runtime limits (commands & flags) ───────────────────────────
const DEFAULT_MAX_DEPTH = 2;
const MAX_DEPTH_HARD_LIMIT = 10;
const DEFAULT_TIMEOUT_SECS = 1800;
// Max nesting depth: 1 = only the main agent may spawn subagents,
// 2 = subagents may spawn one further level, etc. Prevents runaway forks.
let maxSubagentDepth = DEFAULT_MAX_DEPTH;
// Default per-subagent timeout in seconds, used when a subagent_create call
// doesn't pass `timeout` explicitly. 0 = unlimited.
let defaultTimeoutSecs = DEFAULT_TIMEOUT_SECS;

/** Thrown into the tool-call promise when the PARENT aborts, so the child can
 * detach and keep running instead of being killed mid-flight. */
class ParentAbortedError extends Error {
  constructor() {
    super("Subagent was aborted by parent");
  }
}

function parseIntSetting(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : Number.NaN;
}

// ── TUI overlay controls (commands & flag) ──────────────────────
const DEFAULT_MAX_VISIBLE_OVERLAYS = 3;
const MAX_OVERLAYS_HARD_LIMIT = 9;
let overlayEnabled = true;
let maxVisibleOverlays = DEFAULT_MAX_VISIBLE_OVERLAYS;
// Number of cards to skip from the END of the list. 0 means "show the latest
// `maxVisibleOverlays`". Increasing windowOffset pages back into older cards.
let windowOffset = 0;

// ── Key bindings (config file) ──────────────────────────────────
// Read once at load. pi registers extension shortcuts before a session
// exists, so a change to the file needs /reload — /saim-keys says so too.
const keysConfigResult = loadKeysConfig();
const keyConfig = keysConfigResult.keys;
// "Ctrl+Shift", or "" when the numbered inspect shortcuts are switched off.
const INSPECT_LABEL = modifierLabel(keyConfig.inspectModifier);
const PAGE_HINT = `${keyLabel(keyConfig.pageOlderKey)}/${keyLabel(keyConfig.pageNewerKey)}`;

function getVisibleSubagents(): SubagentCard[] {
  if (subagents.length === 0) return [];
  const total = subagents.length;
  const window = Math.min(maxVisibleOverlays, total);
  // Clamp offset to valid range; user paging may have left it stale.
  const maxOffset = Math.max(0, total - window);
  if (windowOffset > maxOffset) windowOffset = maxOffset;
  if (windowOffset < 0) windowOffset = 0;
  const end = total - windowOffset;
  const start = Math.max(0, end - window);
  return subagents.slice(start, end);
}

function unmountWidget() {
  if (!currentCtx) return;
  if (widgetMounted) {
    currentCtx.ui.setWidget("in-memory-subagent-cards", undefined);
  }
  widgetMounted = false;
  widgetTui = null;
}

function closeActiveDetail() {
  if (activeDetailDone) {
    try { activeDetailDone(); } catch {}
  }
  activeDetailTui = null;
  activeDetailDone = null;
}

function renderSubagentCards(theme: any, width: number): string[] {
  if (!overlayEnabled) return [];
  const visible = getVisibleSubagents();
  if (visible.length === 0) return [];

  // Derive cols from columnWidthPercent (all cards share the same value).
  const pct = visible[visible.length - 1].columnWidthPercent;
  const cols = Math.min(3, Math.max(1, Math.round(100 / pct)));
  const gap = 1;
  const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
  const maxContentLines = 4;
  const lines: string[] = [""];

  // Page indicator if there are more cards than fit on screen
  const total = subagents.length;
  if (total > visible.length) {
    const firstVisible = total - windowOffset - visible.length + 1;
    const lastVisible = total - windowOffset;
    const hint = `subagents ${firstVisible}–${lastVisible} of ${total}  (${PAGE_HINT} to page)`;
    lines.push(theme.fg("dim", truncateToWidth(hint, width)));
  }

  for (let i = 0; i < visible.length; i += cols) {
    const rowCards = visible.slice(i, i + cols).map((sa, idx) => {
      const cardTheme = CARD_THEMES[(sa.num - 1) % CARD_THEMES.length];

      const titleText = `${sa.title} [${sa.modelLabel}]`;
      const innerW = colWidth - 4;

      const allText = sa.prompt || "…";
      const contentLines = allText.split("\n");
      const trimmedLines = contentLines.map((l) =>
        visibleWidth(l) > innerW ? truncateToWidth(l, innerW - 1) + "…" : l
      );
      const visibleContentLines = trimmedLines.slice(0, maxContentLines);
      const content = visibleContentLines.join("\n") + (contentLines.length > maxContentLines ? "\n…" : "");

      let statusRaw: string;
      if (sa.status === "created") {
        statusRaw = "⏳ started";
      } else if (sa.status === "running") {
        const dotPhase = Math.floor(Date.now() / 2000) % 3;
        statusRaw = "⚡ working" + ".".repeat(dotPhase + 1);
      } else if (sa.status === "completed") {
        statusRaw = "✅ finished";
      } else {
        statusRaw = "❌ error";
      }

      const STATUS_WIDTH = 14;
      const visPad = Math.max(0, STATUS_WIDTH - visibleWidth(statusRaw));
      const elapsed = formatElapsed(sa.startedAt, sa.endedAt);
      const footer = `${statusRaw}${" ".repeat(visPad)} ${elapsed}`;

      return renderCard({
        title: titleText,
        badge: `#${sa.num}`,
        content,
        footer,
        ...(INSPECT_LABEL ? { footerRight: `${INSPECT_LABEL}+${sa.num}` } : {}),
        colWidth,
        theme,
        cardTheme,
      });
    });

    while (rowCards.length < cols) {
      rowCards.push(Array(rowCards[0].length).fill(" ".repeat(colWidth)));
    }

    const cardHeight = Math.max(...rowCards.map((c) => c.length));
    for (const card of rowCards) {
      while (card.length < cardHeight) {
        card.push(" ".repeat(colWidth));
      }
    }

    for (let row = 0; row < cardHeight; row++) {
      lines.push(rowCards.map((card) => card[row]).join(" ".repeat(gap)));
    }
  }

  return lines;
}

class SubagentCardsWidget {
  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];

  constructor(
    private tui: any,
    private theme: any,
  ) {
    widgetTui = tui;
    widgetMounted = true;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedVersion === widgetRenderVersion) {
      return this.cachedLines;
    }
    this.cachedWidth = width;
    this.cachedVersion = widgetRenderVersion;
    this.cachedLines = renderSubagentCards(this.theme, width);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedVersion = -1;
  }

  dispose(): void {
    if (widgetTui === this.tui) widgetTui = null;
    widgetMounted = false;
  }
}

function ensureSubagentWidget() {
  if (!currentCtx || widgetMounted) return;
  currentCtx.ui.setWidget(
    "in-memory-subagent-cards",
    (tui: any, theme: any) => new SubagentCardsWidget(tui, theme),
    { placement: "aboveEditor" }
  );
}

function syncAnimationTimer() {
  const needsAnimation = hasActiveSubagents() || !!activeDetailTui;
  if (needsAnimation && !flashTimer) {
    flashTimer = setInterval(() => {
      if (!hasActiveSubagents() && !activeDetailTui) {
        syncAnimationTimer();
        return;
      }
      widgetRenderVersion++;
      try { widgetTui?.requestRender(); } catch {}
      try { activeDetailTui?.requestRender(); } catch {}
    }, WIDGET_ANIMATION_INTERVAL_MS);
    return;
  }

  if (!needsAnimation && flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
}

function requestSubagentRender() {
  widgetRenderVersion++;
  syncAnimationTimer();

  if (!currentCtx) return;
  if (!overlayEnabled || subagents.length === 0) {
    unmountWidget();
    try { activeDetailTui?.requestRender(); } catch {}
    return;
  }

  ensureSubagentWidget();
  try { widgetTui?.requestRender(); } catch {}
  try { activeDetailTui?.requestRender(); } catch {}
}

// ── Detail overlay component ────────────────────────────────────
class SubagentDetailOverlay implements Focusable {
  focused = false;

  constructor(
    private card: SubagentCard,
    private cardNum: number,
    private theme: any,
    private done: (result: void) => void,
  ) {}

  handleInput(data: string): void {
    // Close on Escape, Enter, or the same inspect key that opened it
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "return") ||
      (keyConfig.inspectModifier !== undefined &&
        matchesKey(data, inspectKeyId(keyConfig.inspectModifier, this.cardNum)))
    ) {
      this.done();
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const sa = this.card;
    const innerW = width - 2; // borders are 2 chars total

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
    const divider = () =>
      th.fg("border", "├" + "─".repeat(innerW) + "┤");

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));

    // Header
    const statusIcon = sa.status === "created" ? "⏳"
      : sa.status === "running" ? "⚡"
      : sa.status === "completed" ? "✅"
      : "❌";
    const headerText = ` ${statusIcon} Subagent #${sa.num}: ${sa.title} [${sa.modelLabel}]`;
    lines.push(row(th.fg("accent", th.bold(truncateToWidth(headerText, innerW)))));
    lines.push(row(th.fg("dim", ` ${formatElapsed(sa.startedAt, sa.endedAt)} elapsed`)));

    // Prompt section — word-wrap to show at least 3 lines, max 5
    lines.push(divider());
    lines.push(row(th.fg("accent", " PROMPT")));
    const promptWrapWidth = innerW - 2; // 1 char padding each side
    const promptLines = wrapTextWithAnsi(sa.prompt, promptWrapWidth);
    const PROMPT_MIN = 3;
    const PROMPT_MAX = 5;
    const promptDisplay = promptLines.slice(0, PROMPT_MAX);
    for (const pl of promptDisplay) {
      lines.push(row(" " + th.fg("text", truncateToWidth(pl, innerW - 1))));
    }
    // Pad to minimum rows so prompt section is always visible
    for (let r = promptDisplay.length; r < PROMPT_MIN; r++) {
      lines.push(row(""));
    }
    if (promptLines.length > PROMPT_MAX) {
      lines.push(row(th.fg("dim", ` … (${promptLines.length - PROMPT_MAX} more lines)`)));
    }

    // Messages section — always show latest 5 lines
    lines.push(divider());
    lines.push(row(th.fg("accent", " MESSAGES")));

    const MSG_VISIBLE = 5;
    const msgText = sa.messages || "(no messages yet)";
    const allMsgLines = msgText.split("\n");
    // Always auto-scroll to the latest lines
    const msgStart = Math.max(0, allMsgLines.length - MSG_VISIBLE);
    const visibleMsgLines = allMsgLines.slice(msgStart);
    for (const ml of visibleMsgLines) {
      lines.push(row(" " + th.fg("muted", truncateToWidth(ml, innerW - 1))));
    }
    // Pad to minimum rows
    for (let r = visibleMsgLines.length; r < MSG_VISIBLE; r++) {
      lines.push(row(""));
    }
    if (allMsgLines.length > MSG_VISIBLE) {
      lines.push(row(th.fg("dim", ` … ${allMsgLines.length - MSG_VISIBLE} earlier lines hidden`)));
    }

    // Bottom border with right-aligned hint
    const hint = INSPECT_LABEL ? ` Esc / ${INSPECT_LABEL}+${sa.num} ` : " Esc ";
    const hintLen = hint.length;
    const dashBefore = Math.max(0, innerW - hintLen);
    lines.push(
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
      th.fg("dim", hint) +
      th.fg("border", "╯")
    );

    return lines;
  }

  invalidate(): void {}
  dispose(): void {
    activeDetailTui = null;
    syncAnimationTimer();
    requestSubagentRender();
  }
}

// ── Parameter schema ────────────────────────────────────────────
const SubagentParams = Type.Object({
  task: Type.String({ description: "The task for the subagent to perform" }),
  title: Type.Optional(
    Type.String({ description: "Display title for the subagent card. Defaults to a truncated version of the task." })
  ),
  provider: Type.Optional(
    Type.String({ description: "LLM provider (e.g. 'anthropic', 'google'). Defaults to the main agent's provider." })
  ),
  model: Type.Optional(
    Type.String({ description: "Model ID (e.g. 'claude-sonnet-4-5'). Defaults to the main agent's model." })
  ),
  thinkingLevel: Type.Optional(
    Type.Unsafe<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">({
      type: "string",
      enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      description: "Reasoning effort for the subagent. Defaults to 'off'.",
    })
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the subagent. Defaults to the main agent's cwd." })
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds for the subagent execution. If exceeded, the subagent is aborted " +
        "(its own in-flight nested subagents keep running and still write their results). " +
        "Defaults to the configured default timeout (1800s unless changed via --saim-timeout or /saim-timeout). " +
        "Leave this unset (do not pass a value) unless you can estimate the runtime accurately. " +
        "Do not pass small values such as 300 (5 minutes) — in practice those cut the subagent off " +
        "before it finishes and the job is left incomplete.",
      minimum: 1,
    })
  ),
  columnWidthPercent: Type.Optional(
    Type.Number({
      description:
        "Width of this subagent's card as a percentage of terminal width (e.g. 50 for 2 parallel agents, 33 for 3). " +
        "Max 3 cards per row. Defaults to 50.",
      minimum: 33,
      maximum: 100,
    })
  ),
});

type SubagentParamsType = Static<typeof SubagentParams>;

// ── Core execution logic ────────────────────────────────────────
async function executeSubagent(
  toolCallId: string,
  params: SubagentParamsType,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  fallbackProvider?: string,
  fallbackModel?: string,
  fallbackCwd?: string,
  depth: number = 1,
): Promise<AgentToolResult<any>> {
  if (depth > maxSubagentDepth) {
    throw new Error(
      `Subagent nesting depth limit reached (max depth ${maxSubagentDepth}, see /saim-max-depth). ` +
        "Perform the task directly instead of delegating to another subagent.",
    );
  }
  if (signal?.aborted) {
    throw new Error("Subagent was aborted before it started");
  }

  subagentCount++;
  const subagentNum = subagents.length + 1; // display number based on currently visible cards
  const outDir = join(".pi", "subagent-in-memory", mainSessionId, `subagent_${subagentCount}`);
  mkdirSync(outDir, { recursive: true });

  // Parse "provider/model" format (e.g. "openai/gpt-4o-mini")
  let providerName = params.provider ?? fallbackProvider;
  let modelId = params.model ?? fallbackModel;
  if (modelId && !params.provider && modelId.includes("/")) {
    const slashIdx = modelId.indexOf("/");
    providerName = modelId.slice(0, slashIdx);
    modelId = modelId.slice(slashIdx + 1);
  }

  if (!providerName || !modelId) {
    throw new Error("Could not determine model. Provide provider and model parameters.");
  }

  // Known pi 0.8x limitation: running a second openai-codex session in the
  // same process leaves the PARENT session's next request hanging
  // indefinitely (the subagent itself completes fine). Reproduced with both
  // the websocket and sse transports, so it appears to be per-account state
  // on the ChatGPT backend rather than a transport bug. Warn loudly so users
  // know to pass a different provider/model for subagents.
  if (providerName === "openai-codex") {
    console.warn(
      `[subagent] WARNING: subagent uses ${providerName}/${modelId}. If the main agent also runs on ` +
        `openai-codex, its next request will likely hang after this subagent finishes (known pi 0.8x ` +
        `issue with two codex sessions in one process). Pass a different provider/model to the ` +
        `subagent tool, e.g. provider "xai" model "grok-4.5".`,
    );
  }

  const cwd = params.cwd ?? fallbackCwd ?? process.cwd();

  // Create pi's normal cwd-bound services first. This loads packages from
  // ~/.pi/agent/settings.json and <cwd>/.pi/settings.json, then applies any
  // extension-provided registerProvider() calls to the model runtime. Resolving
  // the requested model after this step is what makes package-provided models
  // such as openai-codex/gpt-5.5 visible to subagents.
  const services = await createAgentSessionServices({ cwd });
  const resolvedModel = services.modelRuntime.getModel(providerName, modelId);
  if (!resolvedModel) {
    const providerModels = services.modelRuntime
      .getModels(providerName)
      .map((model) => model.id)
      .sort();
    const diagnostics = services.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message);
    const details = [
      providerModels.length > 0
        ? `Known models for ${providerName}: ${providerModels.join(", ")}`
        : `Provider ${providerName} has no registered models.`,
      diagnostics.length > 0 ? `Service diagnostics: ${diagnostics.join("; ")}` : undefined,
    ].filter(Boolean).join(" ");
    throw new Error(`Could not find model ${providerName}/${modelId}. ${details}`.trim());
  }

  // Timeout handling — explicit params.timeout wins, otherwise the configured
  // default applies. 0 means unlimited. Resolved before session creation so the
  // nested subagent_create tool can advertise this subagent's own budget.
  const timeoutSecs = params.timeout ?? defaultTimeoutSecs;

  // Subagents at the max depth don't get the subagent_create tool at all, so
  // the LLM can't even attempt a deeper fork.
  const canNest = depth < maxSubagentDepth;
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
    model: resolvedModel,
    thinkingLevel: params.thinkingLevel ?? "off",
    // Keep subagent context/tool surface intentionally small: built-in coding
    // tools plus nested subagent support. Package extensions are still loaded
    // above so provider registrations are available, but their tools are not
    // activated unless explicitly listed here.
    tools: canNest
      ? ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent_create", "subagent_kill"]
      : ["read", "bash", "edit", "write", "grep", "find", "ls"],
    customTools: canNest
      ? [
          createSubagentAgentTool(providerName, modelId, cwd, depth + 1, timeoutSecs),
          // Can only target its own children (and deeper), never itself or a peer.
          createSubagentKillTool(depth + 1),
        ]
      : [],
  });

  // Set up JSONL event log
  const jsonlPath = join(outDir, "events.jsonl");
  const sessionTs = new Date().toISOString();
  jsonlAppend(jsonlPath, {
    type: "session",
    version: 1,
    id: session.sessionId,
    timestamp: sessionTs,
    cwd,
    provider: providerName,
    model: modelId,
    thinkingLevel: params.thinkingLevel ?? "off",
    task: params.task,
    title: params.title,
    depth,
  });
  let lastEventId = session.sessionId;

  // Track card
  const card: SubagentCard = {
    num: subagentNum,
    sessionId: session.sessionId,
    title: params.title ?? params.task.slice(0, 30),
    modelLabel: modelId,
    status: "created",
    prompt: params.task,
    messages: "",
    columnWidthPercent: params.columnWidthPercent ?? 50,
    startedAt: Date.now(),
  };
  subagents.push(card);
  requestSubagentRender();

  onUpdate?.({
    content: [{ type: "text", text: `Subagent session created: ${session.sessionId}` }],
    details: { sessionId: session.sessionId, status: "created" },
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  if (timeoutSecs > 0) {
    timeoutTimer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutSecs * 1000);
  }

  // Hoisted out of the run promise so error paths can salvage partial output.
  let finalText = "";

  // Assigned synchronously by the run promise's executor below, so the timeout
  // timer and `subagent_kill` can both end the run from outside it.
  let stopRun: (cardNote: string, errorMessage: string) => boolean = () => false;

  const runPromise = new Promise<string>((resolve, reject) => {
      let textDeltaBuffer = "";
      let toolcallDeltaBuffer = "";
      let lastPartialUpdateAt = 0;
      let lastPartialUpdateText = "";
      // True between the model finishing a tool-call block and that tool
      // actually starting execution. If the session ends in this state, the
      // provider/agent loop dropped a tool call on the floor — worth surfacing
      // instead of reporting a bland "no text output".
      let pendingToolCall = false;

      const buildPartialText = (extraLine?: string) => {
        let text = finalText;
        if (text.length > MAX_PARTIAL_UPDATE_CHARS) {
          text = `…${text.slice(-MAX_PARTIAL_UPDATE_CHARS)}`;
        }
        if (extraLine) {
          text = text ? `${text}\n${extraLine}` : extraLine;
        }
        return text || "...";
      };

      const emitPartialUpdate = (details: Record<string, any>, extraLine?: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastPartialUpdateAt < PARTIAL_UPDATE_INTERVAL_MS) return;

        const text = buildPartialText(extraLine);
        if (!force && text === lastPartialUpdateText) return;

        lastPartialUpdateAt = now;
        lastPartialUpdateText = text;
        onUpdate?.({
          content: [{ type: "text", text }],
          details,
        });
      };

      session.subscribe((event) => {
        const updateData: Record<string, any> = {
          type: event.type,
          sessionId: session.sessionId,
        };

        const eventId = randomUUID().slice(0, 8);
        const eventTs = new Date().toISOString();
        const baseLog = { type: event.type, id: eventId, parentId: lastEventId, timestamp: eventTs };

        switch (event.type) {
          case "agent_start":
            card.status = "running";
            appendMessage(card, "[agent started]");
            requestSubagentRender();
            jsonlAppend(jsonlPath, baseLog);
            lastEventId = eventId;
            onUpdate?.({
              content: [{ type: "text", text: "Subagent started..." }],
              details: updateData,
            });
            break;

          case "message_update": {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              textDeltaBuffer += ame.delta;
              finalText += ame.delta;
              // Append delta text to messages for live view
              appendMessageChunk(card, ame.delta);
              emitPartialUpdate({
                ...updateData,
                data: { assistantMessageEventType: ame.type, textLength: finalText.length },
              });
            } else if (ame.type === "text_end") {
              if (textDeltaBuffer) {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: "text", text: textDeltaBuffer } });
                textDeltaBuffer = "";
              } else {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              }
              lastEventId = eventId;
              emitPartialUpdate({
                ...updateData,
                data: { assistantMessageEventType: ame.type, textLength: finalText.length },
              }, undefined, true);
            } else if (ame.type === "toolcall_delta") {
              if ("delta" in ame) toolcallDeltaBuffer += (ame as any).delta ?? "";
            } else if (ame.type === "toolcall_end") {
              pendingToolCall = true;
              if (toolcallDeltaBuffer) {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: "toolcall", content: toolcallDeltaBuffer } });
                toolcallDeltaBuffer = "";
              } else {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              }
              lastEventId = eventId;
            } else if (ame.type === "text_start" || ame.type === "toolcall_start") {
              // Skip start markers
            } else {
              jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              lastEventId = eventId;
            }
            break;
          }

          case "tool_execution_start":
            pendingToolCall = false;
            appendMessage(card, `[🔧 ${event.toolName} ⏳]`);
            jsonlAppend(jsonlPath, { ...baseLog, toolName: event.toolName, args: event.args });
            lastEventId = eventId;
            emitPartialUpdate(
              {
                ...updateData,
                data: { toolName: event.toolName, args: event.args },
              },
              `[Tool: ${event.toolName}]`,
              true,
            );
            break;

          case "tool_execution_end":
            appendMessage(card, `[🔧 ${event.toolName} ${event.isError ? "❌" : "✅"}]`);
            jsonlAppend(jsonlPath, { ...baseLog, toolName: event.toolName, isError: event.isError, result: event.result });
            lastEventId = eventId;
            emitPartialUpdate(
              {
                ...updateData,
                data: { toolName: event.toolName, isError: event.isError },
              },
              `[Tool: ${event.toolName} ${event.isError ? "❌" : "✅"}]`,
              true,
            );
            break;

          case "agent_end":
            card.status = "completed";
            card.endedAt = Date.now();
            appendMessage(card, "[agent completed]");
            requestSubagentRender();
            jsonlAppend(jsonlPath, {
              ...baseLog,
              finalTextLength: finalText.length,
              ...(pendingToolCall && !finalText.trim() ? { endedWithUnexecutedToolCall: true } : {}),
            });
            if (finalText.trim()) {
              resolve(finalText);
            } else {
              const diagnosis = pendingToolCall
                ? "The session ended right after the model emitted a tool call that was never executed " +
                  "(likely a provider or agent-loop fault) — treat this result as incomplete."
                : "The session ended without producing any text output.";
              resolve(
                `Subagent completed with no text output. ${diagnosis}\n\n` +
                  `## Recent activity\n\n\`\`\`\n${activityTail(card)}\n\`\`\`\n\n` +
                  `The full event stream (every tool call and result) is in \`${jsonlPath}\` — ` +
                  `partial findings can be harvested from there.`,
              );
            }
            break;

          case "turn_start":
          case "turn_end":
          case "message_start":
          case "message_end":
            jsonlAppend(jsonlPath, baseLog);
            lastEventId = eventId;
            emitPartialUpdate(updateData);
            break;

          default:
            jsonlAppend(jsonlPath, { ...baseLog, raw: event });
            lastEventId = eventId;
            break;
        }
      });

      // Ends the run early — on timeout, or when `subagent_kill` targets this
      // subagent. Aborts only this subagent's own session: its in-flight nested
      // subagents receive the abort as a PARENT abort and detach instead of
      // dying (see ParentAbortedError handling below), so their work is still
      // written to disk.
      stopRun = (cardNote, errorMessage) => {
        // The timer can fire in the narrow window between agent_end resolving
        // the promise and finalizeSuccess clearing the timer — don't clobber a
        // finished card's status in that case.
        if (card.endedAt !== undefined) return false;
        session.abort();
        card.status = "error";
        card.endedAt = Date.now();
        appendMessage(card, `[${cardNote}]`);
        requestSubagentRender();
        reject(new Error(errorMessage));
        return true;
      };

      timeoutController.signal.addEventListener("abort", () => {
        stopRun(`timed out after ${timeoutSecs}s`, `Subagent timed out after ${timeoutSecs}s`);
      });

      session.prompt(params.task).catch((err) => {
        card.status = "error";
        card.endedAt = Date.now();
        appendMessage(card, `[error: ${err?.message ?? String(err)}]`);
        requestSubagentRender();
        reject(err);
      });
  });

  // Killable until result.md / error.md has been written — including while
  // detached after a parent abort.
  runningSubagents.set(session.sessionId, {
    card,
    outDir,
    depth,
    kill: (reason) => stopRun(`killed: ${reason}`, `Subagent was killed: ${reason}`),
  });

  const finalizeSuccess = async (result: string): Promise<string> => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    runningSubagents.delete(session.sessionId);
    session.dispose();
    await flushJsonl(jsonlPath);
    const resultPath = join(outDir, "result.md");
    writeFileSync(resultPath, result, "utf-8");
    return resultPath;
  };

  const finalizeError = async (err: any): Promise<{ errorPath: string; partialPath?: string }> => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    runningSubagents.delete(session.sessionId);
    session.dispose();
    await flushJsonl(jsonlPath);
    const errorMsg = err?.message ?? String(err);
    const errorPath = join(outDir, "error.md");
    let body = `# Subagent Error\n\n${errorMsg}\n`;
    let partialPath: string | undefined;
    if (finalText.trim()) {
      partialPath = join(outDir, "partial-result.md");
      writeFileSync(partialPath, finalText, "utf-8");
      body += `\nPartial output produced before the failure was saved to \`partial-result.md\`.\n`;
    }
    // A subagent that spent its whole budget on tool calls (browsing, greps…)
    // has an empty finalText, but its work is not lost: surface the activity
    // tail and point at events.jsonl so a coordinator can harvest findings.
    body += `\n## Recent activity\n\n\`\`\`\n${activityTail(card)}\n\`\`\`\n`;
    body +=
      `\nThe full event stream (every tool call and its result) is in \`events.jsonl\` ` +
      `in this folder — partial findings can be harvested from there even though the run failed.\n`;
    writeFileSync(errorPath, body, "utf-8");
    return { errorPath, partialPath };
  };

  // A parent abort races against the run instead of killing the session, so
  // a timed-out/aborted parent can no longer destroy useful child work.
  let parentAbortPromise: Promise<never> | undefined;
  if (signal) {
    parentAbortPromise = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new ParentAbortedError()), { once: true });
    });
  }

  try {
    const result = await (parentAbortPromise ? Promise.race([runPromise, parentAbortPromise]) : runPromise);
    const resultPath = await finalizeSuccess(result);
    return {
      content: [{ type: "text", text: `Execution succeeded. Result is in \`${resultPath}\`` }],
      details: { sessionId: session.sessionId, status: "completed", outputDir: outDir },
    };
  } catch (err: any) {
    if (err instanceof ParentAbortedError) {
      // The parent aborted (typically because it hit its own timeout) while
      // this subagent was still working. Don't kill it — detach: let it run
      // to completion, still bounded by its own timeout, and write result.md
      // / error.md as usual so the work can be harvested later.
      appendMessage(card, "[parent aborted — continuing detached]");
      requestSubagentRender();
      runPromise
        .then((result) => finalizeSuccess(result))
        .catch((e) => finalizeError(e))
        .catch(() => {});
      return {
        content: [
          {
            type: "text",
            text:
              "Subagent was aborted by its parent but continues running detached (its own timeout still applies). " +
              `Its result will be written to \`${outDir}\` when it finishes. ` +
              `To stop it early, call subagent_kill with sessionId \`${session.sessionId}\`.`,
          },
        ],
        details: { sessionId: session.sessionId, status: "detached", outputDir: outDir },
      };
    }

    const { errorPath, partialPath } = await finalizeError(err);
    return {
      content: [
        {
          type: "text",
          text:
            `Execution failed. Detail is in \`${errorPath}\`` +
            (partialPath ? ` (partial output in \`${partialPath}\`)` : "") +
            `. The full activity log is in \`${join(outDir, "events.jsonl")}\` — ` +
            `if the subagent did useful tool work before failing, harvest it from there instead of redoing it.`,
        },
      ],
      details: { sessionId: session.sessionId, status: "error", outputDir: outDir },
    };
  }
}

// ── subagent_kill ───────────────────────────────────────────────
const SubagentKillParams = Type.Object({
  sessionId: Type.Optional(
    Type.String({
      description:
        "Session ID of the subagent to kill (the most reliable identifier). " +
        "Call this tool with no arguments to list running subagents and their session IDs.",
    })
  ),
  num: Type.Optional(
    Type.Number({
      description: "Card number of the subagent to kill, as shown on its TUI card badge (#N). Ignored if sessionId is given.",
      minimum: 1,
    })
  ),
  reason: Type.Optional(
    Type.String({ description: "Why the subagent is being killed. Recorded in its error.md." })
  ),
});

type SubagentKillParamsType = Static<typeof SubagentKillParams>;

const SUBAGENT_KILL_DESCRIPTION =
  "Kill a running subagent that is stuck, instead of waiting for its timeout to expire. " +
  "Identify it by sessionId (preferred) or by the card number shown on its TUI card; " +
  "calling with no arguments returns the list of running subagents. " +
  "The killed subagent still writes error.md (plus partial-result.md if it had produced text) " +
  "and its events.jsonl to its output directory, so its work so far can be harvested. " +
  "Nested subagents it spawned are NOT killed — they detach, keep running under their own " +
  "timeouts, and write their own results.";

function killableSubagents(minDepth: number): RunningSubagent[] {
  // A subagent can only kill things at or below the nesting level it spawns,
  // never an ancestor or a peer at its own level.
  return [...runningSubagents.values()].filter((entry) => entry.depth >= minDepth);
}

function describeRunning(entries: RunningSubagent[]): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map(
      (e) =>
        `- #${e.card.num} \`${e.card.sessionId}\` — ${e.card.title} [${e.card.modelLabel}], ` +
        `${e.card.status}, ${formatElapsed(e.card.startedAt, e.card.endedAt)} elapsed, output dir \`${e.outDir}\``
    )
    .join("\n");
}

async function executeSubagentKill(
  params: SubagentKillParamsType,
  minDepth: number,
): Promise<AgentToolResult<any>> {
  const candidates = killableSubagents(minDepth);
  const wantedId = params.sessionId?.trim();
  const wantedNum = typeof params.num === "number" ? params.num : undefined;

  if (!wantedId && wantedNum === undefined) {
    return {
      content: [
        {
          type: "text",
          text:
            `Running subagents:\n\n${describeRunning(candidates)}\n\n` +
            (candidates.length > 0
              ? "Call subagent_kill again with the sessionId of the one to stop."
              : "Nothing to kill."),
        },
      ],
      details: {
        status: "listed",
        running: candidates.map((e) => ({
          num: e.card.num,
          sessionId: e.card.sessionId,
          title: e.card.title,
          status: e.card.status,
          outputDir: e.outDir,
        })),
      },
    };
  }

  let target: RunningSubagent | undefined;
  if (wantedId) {
    target = candidates.find((e) => e.card.sessionId === wantedId);
  } else {
    const matches = candidates.filter((e) => e.card.num === wantedNum);
    if (matches.length > 1) {
      throw new Error(
        `Multiple running subagents share card number #${wantedNum}. Kill by sessionId instead:\n${describeRunning(matches)}`,
      );
    }
    target = matches[0];
  }

  if (!target) {
    throw new Error(
      `No running subagent matches ${wantedId ? `sessionId ${wantedId}` : `card number #${wantedNum}`} — ` +
        `it may have already finished (check its output directory).\nRunning subagents:\n${describeRunning(candidates)}`,
    );
  }

  const reason = params.reason?.trim() || "killed by the calling agent";
  const { card, outDir } = target;
  if (!target.kill(reason)) {
    throw new Error(
      `Subagent #${card.num} (${card.sessionId}) finished before it could be killed; its result is in \`${outDir}\`.`,
    );
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Killed subagent #${card.num} (\`${card.sessionId}\`, ${card.title}): ${reason}. ` +
          `Its error.md, any partial-result.md, and the full events.jsonl are written to \`${outDir}\` — ` +
          `harvest whatever useful work it did from there. Nested subagents it spawned keep running detached.`,
      },
    ],
    details: { status: "killed", sessionId: card.sessionId, outputDir: outDir, reason },
  };
}

// ── AgentTool factory for nested subagent sessions ──────────────
function createSubagentAgentTool(
  parentProvider: string,
  parentModel: string,
  parentCwd: string,
  childDepth: number,
  parentBudgetSecs: number,
): ToolDefinition<typeof SubagentParams> {
  // The spawning agent has no other way to know its own timeout, and fan-outs
  // sized without that knowledge burn the whole budget waiting on children
  // (child timeout + integration must fit inside the parent's budget). The
  // tool schema is the one place this extension is allowed to say so.
  const budgetNote =
    parentBudgetSecs > 0
      ? ` IMPORTANT: your own execution budget is ${parentBudgetSecs}s from your session start. ` +
        `Give nested subagents timeouts well below your remaining time so you can still collect and ` +
        `integrate their results before your own deadline; also instruct them to persist intermediate ` +
        `findings to files so a timeout does not lose their work.`
      : "";
  return {
    name: "subagent_create",
    label: "Subagent",
    description:
      "Create a subagent to perform a task. The subagent runs in-process with its own session. " +
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes. " +
      "Nesting is limited to a configured max depth — if the limit is reached, do the work directly instead." +
      budgetNote,
    parameters: SubagentParams,
    async execute(
      toolCallId: string,
      params: SubagentParamsType,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      _ctx?: any,
    ) {
      return executeSubagent(
        toolCallId,
        params,
        signal,
        onUpdate,
        parentProvider,
        parentModel,
        parentCwd,
        childDepth,
      );
    },
  };
}

/** `subagent_kill` for a nested session. `minDepth` is the depth of the
 * subagents this agent spawns, so it can stop its own children but not itself,
 * a peer, or an ancestor. */
function createSubagentKillTool(minDepth: number): ToolDefinition<typeof SubagentKillParams> {
  return {
    name: "subagent_kill",
    label: "Subagent Kill",
    description: SUBAGENT_KILL_DESCRIPTION,
    parameters: SubagentKillParams,
    async execute(
      _toolCallId: string,
      params: SubagentKillParamsType,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: any,
    ) {
      return executeSubagentKill(params, minDepth);
    },
  };
}

// ── Extension entry point ───────────────────────────────────────
export default function (pi: ExtensionAPI) {
  pi.registerFlag("saim-no-tui", {
    description: "Start with the subagent TUI overlay disabled (equivalent to /saim-toggle-overlay off).",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("saim-max-depth", {
    description: `Max subagent nesting depth, 1-${MAX_DEPTH_HARD_LIMIT} (default ${DEFAULT_MAX_DEPTH}). Prevents runaway subagent forks.`,
    type: "string",
  });

  pi.registerFlag("saim-timeout", {
    description: `Default subagent timeout in seconds, 0 = unlimited (default ${DEFAULT_TIMEOUT_SECS}). Per-call \`timeout\` parameter overrides it.`,
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    mainSessionId = ctx.sessionManager.getSessionId?.() ?? `session-${Date.now()}`;
    subagentCount = 0;
    subagents.length = 0;
    runningSubagents.clear();
    activeDetailTui = null;
    activeDetailDone = null;
    widgetMounted = false;
    widgetTui = null;
    windowOffset = 0;
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    ctx.ui.setWidget("in-memory-subagent-cards", undefined);

    // Apply --saim-no-tui flag if present
    if (pi.getFlag("saim-no-tui") === true) {
      overlayEnabled = false;
    }

    // A typo in the key config would otherwise leave a shortcut silently dead.
    if (keysConfigResult.problems.length > 0) {
      ctx.ui.notify(
        `subagent-in-memory keys: ${keysConfigResult.problems.join("; ")}`,
        "warning",
      );
    }

    // Apply --saim-max-depth / --saim-timeout flags if present
    const depthFlag = parseIntSetting(pi.getFlag("saim-max-depth"));
    if (depthFlag !== undefined) {
      if (Number.isInteger(depthFlag) && depthFlag >= 1 && depthFlag <= MAX_DEPTH_HARD_LIMIT) {
        maxSubagentDepth = depthFlag;
      } else {
        ctx.ui.notify(
          `Invalid --saim-max-depth (expected 1-${MAX_DEPTH_HARD_LIMIT}); keeping ${maxSubagentDepth}`,
          "warning",
        );
      }
    }
    const timeoutFlag = parseIntSetting(pi.getFlag("saim-timeout"));
    if (timeoutFlag !== undefined) {
      if (Number.isInteger(timeoutFlag) && timeoutFlag >= 0) {
        defaultTimeoutSecs = timeoutFlag;
      } else {
        ctx.ui.notify(
          `Invalid --saim-timeout (expected seconds >= 0); keeping ${defaultTimeoutSecs}`,
          "warning",
        );
      }
    }

    requestSubagentRender();
  });

  pi.registerCommand("saim-max-depth", {
    description: `Show or set max subagent nesting depth (1-${MAX_DEPTH_HARD_LIMIT}, default ${DEFAULT_MAX_DEPTH}). Usage: /saim-max-depth [n]`,
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "") {
        ctx.ui.notify(`Max subagent nesting depth: ${maxSubagentDepth}`, "info");
        return;
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DEPTH_HARD_LIMIT) {
        ctx.ui.notify(`Provide an integer between 1 and ${MAX_DEPTH_HARD_LIMIT}.`, "warning");
        return;
      }
      maxSubagentDepth = n;
      ctx.ui.notify(`Max subagent nesting depth set to ${n} (applies to newly created subagents)`, "info");
    },
  });

  pi.registerCommand("saim-timeout", {
    description: `Show or set the default subagent timeout in seconds (0 = unlimited, default ${DEFAULT_TIMEOUT_SECS}). Usage: /saim-timeout [seconds]`,
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const fmt = (secs: number) => (secs === 0 ? "unlimited" : `${secs}s`);
      if (arg === "") {
        ctx.ui.notify(`Default subagent timeout: ${fmt(defaultTimeoutSecs)}`, "info");
        return;
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) {
        ctx.ui.notify("Provide a non-negative integer number of seconds (0 = unlimited).", "warning");
        return;
      }
      defaultTimeoutSecs = n;
      ctx.ui.notify(`Default subagent timeout set to ${fmt(n)} (applies to newly created subagents)`, "info");
    },
  });

  pi.registerCommand("saim-clear-tui-overlay", {
    description: "Clear subagent TUI cards and close any open detail overlay",
    handler: async (_args, ctx) => {
      subagents.length = 0;
      windowOffset = 0;
      closeActiveDetail();
      unmountWidget();
      if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
      ctx.ui.notify("Subagent TUI cards cleared", "info");
    },
  });

  pi.registerCommand("saim-toggle-overlay", {
    description: "Enable or disable subagent detail overlays. Usage: /saim-toggle-overlay [on|off|toggle]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      let next: boolean;
      if (arg === "on" || arg === "true" || arg === "1") {
        next = true;
      } else if (arg === "off" || arg === "false" || arg === "0") {
        next = false;
      } else if (arg === "" || arg === "toggle") {
        next = !overlayEnabled;
      } else {
        ctx.ui.notify(`Unknown argument "${arg}". Use on, off, or toggle.`, "warning");
        return;
      }
      overlayEnabled = next;
      if (!overlayEnabled) {
        // Force-tear down even while subagents are running.
        closeActiveDetail();
        unmountWidget();
      }
      requestSubagentRender();
      ctx.ui.notify(`Subagent TUI overlay ${overlayEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("saim-set-max-tui-overlays", {
    description: `Set max visible subagent cards (1-${MAX_OVERLAYS_HARD_LIMIT}). Older cards remain accessible via ${PAGE_HINT}.`,
    handler: async (args, ctx) => {
      const n = parseInt((args ?? "").trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_OVERLAYS_HARD_LIMIT) {
        ctx.ui.notify(
          `Provide an integer between 1 and ${MAX_OVERLAYS_HARD_LIMIT}.`,
          "warning",
        );
        return;
      }
      maxVisibleOverlays = n;
      windowOffset = 0;
      requestSubagentRender();
      ctx.ui.notify(`Max visible subagent cards set to ${n}`, "info");
    },
  });

  pi.registerCommand("saim-keys", {
    description: "Show the subagent TUI key bindings and where they are configured",
    handler: async (_args, ctx) => {
      const inspect = keyConfig.inspectModifier
        ? `${INSPECT_LABEL}+1 … ${INSPECT_LABEL}+9`
        : "off (the digits stay with the terminal)";
      const lines = [
        `Config: ${keysConfigResult.path}`,
        `inspectModifier: ${keyConfig.inspectModifier ?? "off"}  →  ${inspect}`,
        `pageOlderKey: ${keyConfig.pageOlderKey}  →  ${keyLabel(keyConfig.pageOlderKey)}`,
        `pageNewerKey: ${keyConfig.pageNewerKey}  →  ${keyLabel(keyConfig.pageNewerKey)}`,
      ];
      if (keysConfigResult.problems.length > 0) {
        lines.push("", "Problems:", ...keysConfigResult.problems.map((problem) => `  - ${problem}`));
      }
      lines.push("", "Edit the file, then run /reload to apply.");
      ctx.ui.notify(lines.join("\n"), keysConfigResult.problems.length > 0 ? "warning" : "info");
    },
  });

  // Page through cards when there are more subagents than fit on screen.
  pi.registerShortcut(keyConfig.pageOlderKey, {
    description: "Page to older subagent cards",
    handler: async (ctx) => {
      if (!overlayEnabled) return;
      const total = subagents.length;
      const window = Math.min(maxVisibleOverlays, total);
      const maxOffset = Math.max(0, total - window);
      if (windowOffset >= maxOffset) {
        ctx.ui.notify("Already showing the oldest subagents", "info");
        return;
      }
      windowOffset = Math.min(maxOffset, windowOffset + window);
      requestSubagentRender();
    },
  });

  pi.registerShortcut(keyConfig.pageNewerKey, {
    description: "Page to newer subagent cards",
    handler: async (ctx) => {
      if (!overlayEnabled) return;
      if (windowOffset === 0) {
        ctx.ui.notify("Already showing the latest subagents", "info");
        return;
      }
      const window = Math.min(maxVisibleOverlays, subagents.length);
      windowOffset = Math.max(0, windowOffset - window);
      requestSubagentRender();
    },
  });

  // Register the configured inspect shortcuts for cards 1-9, `ctrl+shift` by
  // default. The number maps to the position WITHIN the currently visible
  // window (1 = first visible card), not the absolute subagent number.
  //
  // Plain `ctrl+<digit>` is deliberately not the default: terminal
  // multiplexers and terminal apps (tmux, Herdr, kitty) claim it for their own
  // tabs or spaces and the program never sees the key. `inspectModifier: "off"`
  // in the config file leaves the digits alone entirely.
  const inspectModifier = keyConfig.inspectModifier;
  for (let n = 1; n <= 9 && inspectModifier !== undefined; n++) {
    pi.registerShortcut(inspectKeyId(inspectModifier, n), {
      description: `Inspect visible subagent #${n}`,
      handler: async (ctx) => {
        if (!overlayEnabled) {
          ctx.ui.notify("Subagent TUI overlay is disabled", "warning");
          return;
        }
        const visible = getVisibleSubagents();
        const card = visible[n - 1];
        if (!card) {
          ctx.ui.notify(`No visible subagent #${n}`, "warning");
          return;
        }

        await ctx.ui.custom<void>(
          (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
            activeDetailTui = tui;
            activeDetailDone = done;
            return new SubagentDetailOverlay(card, n, theme, done);
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "80%",
              maxHeight: "80%",
              minWidth: 60,
            },
          }
        );

        activeDetailTui = null;
        activeDetailDone = null;
        syncAnimationTimer();
        requestSubagentRender();
      },
    });
  }

  pi.registerTool<typeof SubagentParams>({
    name: "subagent_create",
    label: "Subagent",
    description:
      "Create a subagent to perform a task. The subagent runs in-process with its own session. " +
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes. " +
      "Nesting is limited to a configured max depth — if the limit is reached, do the work directly instead.",
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mainModel = ctx.model;
      const providerName = params.provider ?? mainModel?.provider;
      const modelId = params.model ?? mainModel?.id;
      const cwd = params.cwd ?? ctx.cwd;

      return executeSubagent(
        toolCallId,
        params,
        signal,
        onUpdate,
        providerName,
        modelId,
        cwd,
        1,
      );
    },
  });

  pi.registerTool<typeof SubagentKillParams>({
    name: "subagent_kill",
    label: "Subagent Kill",
    description: SUBAGENT_KILL_DESCRIPTION,
    parameters: SubagentKillParams,

    async execute(_toolCallId, params) {
      // The main agent sits above every subagent, so nothing is out of reach.
      return executeSubagentKill(params, 1);
    },
  });
}
