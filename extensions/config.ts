/**
 * config.ts — user-tunable key bindings for the subagent TUI.
 *
 * Read from `<agent dir>/subagent-in-memory.json`, which is
 * `~/.pi/agent/subagent-in-memory.json` unless `PI_CODING_AGENT_DIR` says
 * otherwise:
 *
 * ```json
 * {
 *   "inspectModifier": "ctrl+shift",
 *   "pageOlderKey": "ctrl+alt+left",
 *   "pageNewerKey": "ctrl+alt+right"
 * }
 * ```
 *
 * Every field is optional; anything missing keeps its default. The file is
 * read once when the extension loads, because pi registers extension
 * shortcuts before the session exists — edit the file and run `/reload` to
 * apply a change.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "subagent-in-memory.json";

export interface KeysConfig {
  /**
   * Modifier prefix for the numbered inspect shortcuts (`ctrl+shift` binds
   * `ctrl+shift+1` … `ctrl+shift+9`). `undefined` leaves the shortcuts
   * unbound, so the terminal keeps the digits.
   */
  inspectModifier: string | undefined;
  /** Opens a detail overlay on an older page of cards. */
  pageOlderKey: KeyId;
  /** Opens a detail overlay on a newer page of cards. */
  pageNewerKey: KeyId;
}

/**
 * `ctrl+shift` rather than plain `ctrl`: terminal multiplexers, terminal
 * emulators and desktop terminal apps (tmux, Herdr, kitty, WezTerm layouts)
 * commonly claim `ctrl+<digit>` for their own tabs or spaces and swallow it
 * before the program sees it.
 */
export const DEFAULT_KEYS: KeysConfig = {
  inspectModifier: "ctrl+shift",
  pageOlderKey: "ctrl+alt+left",
  pageNewerKey: "ctrl+alt+right",
};

const KNOWN_FIELDS = ["inspectModifier", "pageOlderKey", "pageNewerKey"] as const;

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Canonical order, so `shift+ctrl+1` and `ctrl+shift+1` are one binding. */
const MODIFIER_ORDER: Modifier[] = ["ctrl", "shift", "alt", "super"];

const NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
  "insert", "clear", "home", "end", "pageup", "pagedown",
  "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}",
  ":", "<", ">", "?",
]);

/** Values that switch a binding off instead of binding it. */
const DISABLED = new Set(["", "none", "off", "disabled", "false"]);

/** Pretty labels for the keys that have no printable character. */
const KEY_LABELS: Record<string, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  pageup: "PgUp",
  pagedown: "PgDn",
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  insert: "Ins",
};

/** Where the user's key config lives. */
export function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

function isModifier(part: string): part is Modifier {
  return (MODIFIERS as readonly string[]).includes(part);
}

function canonicalModifiers(modifiers: Modifier[]): string {
  return MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join("+");
}

/**
 * Parse a modifier prefix such as `ctrl+shift`.
 *
 * Returns `{ modifier: undefined }` for the disabled spellings and a
 * `problem` for anything that is not a usable prefix.
 */
function parseModifier(raw: string): { modifier?: string | undefined; problem?: string } {
  const text = raw.trim().toLowerCase();
  if (DISABLED.has(text)) return { modifier: undefined };

  const parts = text.split("+");
  if (parts.some((part) => part === "")) {
    return { problem: `"${raw}" is not a modifier prefix (expected e.g. "ctrl+shift")` };
  }
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    if (!isModifier(part)) {
      return { problem: `"${raw}" is not a modifier prefix: "${part}" is not one of ctrl, shift, alt, super` };
    }
    if (modifiers.includes(part)) {
      return { problem: `"${raw}" repeats the "${part}" modifier` };
    }
    modifiers.push(part);
  }
  // Shift alone would bind a plain shifted digit, which steals typing.
  if (!modifiers.some((modifier) => modifier !== "shift")) {
    return { problem: `"${raw}" needs ctrl, alt or super: shift alone would capture plain digits` };
  }
  return { modifier: canonicalModifiers(modifiers) };
}

/**
 * Validate a full key such as `ctrl+alt+left`.
 *
 * A bare key is rejected: these bindings sit on top of the editor, so an
 * unmodified key would swallow typing.
 */
function parseKey(raw: string): { key?: KeyId; problem?: string } {
  const text = raw.trim().toLowerCase().replace(/[-_]/g, "+");
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  if (key === "") {
    return { problem: `"${raw}" is not a key (expected e.g. "ctrl+alt+left")` };
  }
  if (!NAMED_KEYS.has(key) && !/^[a-z0-9]$/.test(key)) {
    return { problem: `"${raw}" has an unknown key "${key}"` };
  }
  if (parts.length === 0) {
    return { problem: `"${raw}" needs at least one modifier` };
  }
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    if (!isModifier(part)) {
      return { problem: `"${raw}" has an unknown modifier "${part}"` };
    }
    if (modifiers.includes(part)) {
      return { problem: `"${raw}" repeats the "${part}" modifier` };
    }
    modifiers.push(part);
  }
  return { key: `${canonicalModifiers(modifiers)}+${key}` as KeyId };
}

/**
 * Load the key config, keeping defaults for anything unusable.
 *
 * `problems` are shown as a warning at session start and by `/saim-keys`, so
 * a typo is reported instead of silently leaving a shortcut dead.
 */
export function loadKeysConfig(): { keys: KeysConfig; path: string; problems: string[] } {
  const path = configPath();
  const problems: string[] = [];
  const keys: KeysConfig = { ...DEFAULT_KEYS };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      problems.push(`Could not read ${path}: ${(error as Error).message}. Using default keys.`);
    }
    return { keys, path, problems };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(`${path} is not valid JSON: ${(error as Error).message}. Using default keys.`);
    return { keys, path, problems };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${path} must hold a JSON object. Using default keys.`);
    return { keys, path, problems };
  }

  const file = parsed as Record<string, unknown>;
  for (const field of Object.keys(file)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(field)) {
      problems.push(`${path}: unknown field "${field}" (known: ${KNOWN_FIELDS.join(", ")})`);
    }
  }

  if (file.inspectModifier !== undefined) {
    if (typeof file.inspectModifier !== "string") {
      problems.push(`${path}: "inspectModifier" must be a string such as "ctrl+shift", or "off"`);
    } else {
      const { modifier, problem } = parseModifier(file.inspectModifier);
      if (problem) problems.push(`${path}: ${problem}`);
      else keys.inspectModifier = modifier;
    }
  }

  for (const field of ["pageOlderKey", "pageNewerKey"] as const) {
    const value = file[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      problems.push(`${path}: "${field}" must be a string such as "ctrl+alt+left"`);
      continue;
    }
    const { key, problem } = parseKey(value);
    if (problem) problems.push(`${path}: "${field}" ${problem}`);
    else keys[field] = key!;
  }

  // Two functions on one chord would shadow whichever opened first.
  if (keys.pageOlderKey === keys.pageNewerKey) {
    problems.push(`${path}: "pageOlderKey" and "pageNewerKey" are both ${keys.pageOlderKey}`);
  }

  return { keys, path, problems };
}

/** The KeyId for inspecting visible card `n` (1-based). */
export function inspectKeyId(modifier: string, n: number): KeyId {
  return `${modifier}+${n}` as KeyId;
}

/** `ctrl+shift` → `Ctrl+Shift`, for hints and the footer. */
export function modifierLabel(modifier: string | undefined): string {
  if (!modifier) return "";
  return modifier
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

/** `ctrl+alt+left` → `Ctrl+Alt+←`, for the paging hint. */
export function keyLabel(key: KeyId): string {
  const parts = String(key).split("+");
  const base = parts.pop() ?? "";
  const label = KEY_LABELS[base] ?? base.toUpperCase();
  return [...parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)), label].join("+");
}
