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
 * - Slash commands to control TUI overlay:
 *     /saim-toggle-overlay [on|off]   — enable/disable rendering
 *     /saim-set-max-tui-overlays <N>  — limit visible cards (1-9)
 *     /saim-clear-tui-overlay         — clear all cards & close any overlay
 * - Multi-provider support (Anthropic, OpenAI, Google, etc.)
 * - Ctrl+<N> to inspect subagent prompt & live messages
 * - Ctrl+Alt+Left / Ctrl+Alt+Right to page through cards when there are
 *   more subagents than the visible window allows
 * - --saim-no-tui CLI flag to start with the overlay disabled
 *
 * Results are written to ./.pi/subagent-in-memory/<mainSessionId>/subagent_<N>/result.md
 * (or error.md on failure) so the calling agent gets a short pointer instead of
 * the full output.
 */

import { Type, type Static } from "@sinclair/typebox";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { renderCard, type CardTheme } from "./tui-draw.ts";

import { visibleWidth, truncateToWidth, wrapTextWithAnsi, matchesKey, Key } from "@mariozechner/pi-tui";
import type { Focusable } from "@mariozechner/pi-tui";
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

// ── Shared state — single instance across all nesting levels ────
const subagents: SubagentCard[] = [];
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

// ── TUI overlay controls (commands & flag) ──────────────────────
const DEFAULT_MAX_VISIBLE_OVERLAYS = 3;
const MAX_OVERLAYS_HARD_LIMIT = 9;
let overlayEnabled = true;
let maxVisibleOverlays = DEFAULT_MAX_VISIBLE_OVERLAYS;
// Number of cards to skip from the END of the list. 0 means "show the latest
// `maxVisibleOverlays`". Increasing windowOffset pages back into older cards.
let windowOffset = 0;

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
    const hint = `subagents ${firstVisible}–${lastVisible} of ${total}  (Ctrl+Alt+←/→ to page)`;
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
        footerRight: `Ctrl+${sa.num}`,
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
    // Close on Escape, Enter, or the same Ctrl+N that opened it
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "return") ||
      matchesKey(data, Key.ctrl(`${this.cardNum}` as any))
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
    const hint = ` Esc / Ctrl+${sa.num} `;
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
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the subagent. Defaults to the main agent's cwd." })
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds for the subagent execution. If exceeded, the subagent is aborted. " +
        "Defaults to unlimited (no timeout).",
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
): Promise<AgentToolResult<any>> {
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

  const cwd = params.cwd ?? fallbackCwd ?? process.cwd();

  // Create pi's normal cwd-bound services first. This loads packages from
  // ~/.pi/agent/settings.json and <cwd>/.pi/settings.json, then applies any
  // extension-provided registerProvider() calls to the model registry. Resolving
  // the requested model after this step is what makes package-provided models
  // such as openai-codex/gpt-5.5 visible to subagents.
  const services = await createAgentSessionServices({ cwd });
  const resolvedModel = services.modelRegistry.find(providerName, modelId);
  if (!resolvedModel) {
    const providerModels = services.modelRegistry
      .getAll()
      .filter((model) => model.provider === providerName)
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

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
    model: resolvedModel,
    thinkingLevel: "off",
    // Keep subagent context/tool surface intentionally small: built-in coding
    // tools plus nested subagent support. Package extensions are still loaded
    // above so provider registrations are available, but their tools are not
    // activated unless explicitly listed here.
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent_create"],
    customTools: [createSubagentAgentTool(providerName, modelId, cwd)],
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
    task: params.task,
    title: params.title,
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

  // Timeout handling
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  if (params.timeout) {
    timeoutTimer = setTimeout(() => {
      timeoutController.abort();
    }, params.timeout * 1000);
  }

  const combinedAbort = () => {
    session.abort();
    card.status = "error";
    card.endedAt = Date.now();
    appendMessage(card, "[aborted]");
    requestSubagentRender();
  };

  try {
    const result = await new Promise<string>((resolve, reject) => {
      let finalText = "";
      let textDeltaBuffer = "";
      let toolcallDeltaBuffer = "";
      let lastPartialUpdateAt = 0;
      let lastPartialUpdateText = "";

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
            jsonlAppend(jsonlPath, { ...baseLog, finalTextLength: finalText.length });
            resolve(finalText || "Subagent completed with no text output.");
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

      if (signal) {
        signal.addEventListener("abort", () => {
          combinedAbort();
          reject(new Error("Subagent was aborted"));
        });
      }
      timeoutController.signal.addEventListener("abort", () => {
        combinedAbort();
        reject(new Error(`Subagent timed out after ${params.timeout}s`));
      });

      session.prompt(params.task).catch((err) => {
        card.status = "error";
        card.endedAt = Date.now();
        appendMessage(card, `[error: ${err?.message ?? String(err)}]`);
        requestSubagentRender();
        reject(err);
      });
    });

    if (timeoutTimer) clearTimeout(timeoutTimer);
    session.dispose();
    await flushJsonl(jsonlPath);

    const resultPath = join(outDir, "result.md");
    writeFileSync(resultPath, result, "utf-8");

    return {
      content: [{ type: "text", text: `Execution succeeded. Result is in \`${resultPath}\`` }],
      details: { sessionId: session.sessionId, status: "completed", outputDir: outDir },
    };
  } catch (err: any) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    session.dispose();
    await flushJsonl(jsonlPath);

    const errorMsg = err?.message ?? String(err);
    const errorPath = join(outDir, "error.md");
    writeFileSync(errorPath, `# Subagent Error\n\n${errorMsg}\n`, "utf-8");

    return {
      content: [{ type: "text", text: `Execution failed. Detail is in \`${errorPath}\`` }],
      details: { sessionId: session.sessionId, status: "error", outputDir: outDir },
    };
  }
}

// ── AgentTool factory for nested subagent sessions ──────────────
function createSubagentAgentTool(
  parentProvider: string,
  parentModel: string,
  parentCwd: string,
): ToolDefinition<typeof SubagentParams> {
  return {
    name: "subagent_create",
    label: "Subagent",
    description:
      "Create a subagent to perform a task. The subagent runs in-process with its own session. " +
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes.",
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
      );
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

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    mainSessionId = ctx.sessionManager.getSessionId?.() ?? `session-${Date.now()}`;
    subagentCount = 0;
    subagents.length = 0;
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

    requestSubagentRender();
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
    description: `Set max visible subagent cards (1-${MAX_OVERLAYS_HARD_LIMIT}). Older cards remain accessible via Ctrl+Alt+←/→.`,
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

  // Page through cards when there are more subagents than fit on screen.
  pi.registerShortcut(Key.ctrlAlt("left"), {
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

  pi.registerShortcut(Key.ctrlAlt("right"), {
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

  // Register Ctrl+1 through Ctrl+9 to open subagent detail overlay.
  // The number maps to the position WITHIN the currently visible window
  // (1 = first visible card), not the absolute subagent number.
  for (let n = 1; n <= 9; n++) {
    pi.registerShortcut(Key.ctrl(`${n}` as any), {
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
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes.",
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
      );
    },
  });
}
