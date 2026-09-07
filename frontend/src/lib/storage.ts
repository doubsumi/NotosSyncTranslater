// Session persistence: keep the user's text and language choices across
// reloads (auto-saved, throttled) without ever blocking the main thread.

import type { LangCode } from "./detection";

export interface SavedPane {
  text: string;
  lang: LangCode;
}

export interface SavedSession {
  v: 1;
  left: SavedPane;
  right: SavedPane;
}

const KEY = "notos-sync-translate.session.v1";

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (
      parsed &&
      parsed.v === 1 &&
      parsed.left &&
      parsed.right &&
      typeof parsed.left.text === "string" &&
      typeof parsed.right.text === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSessionSave(left: SavedPane, right: SavedPane): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload: SavedSession = { v: 1, left, right };
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch {
      // Quota exceeded or private mode: silently skip persistence.
    }
  }, 900);
}

export function clearSession(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
