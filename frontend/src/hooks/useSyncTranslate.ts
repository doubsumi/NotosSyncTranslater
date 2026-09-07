// React binding: owns one SyncController instance for the app lifetime and
// mirrors its state into React, plus session persistence and toasts.

import { useCallback, useEffect, useRef, useState } from "react";
import { createApi } from "../lib/api";
import {
  type Alignment,
  type ControllerState,
  type Side,
  type ToastMessage,
  SyncController,
} from "../lib/controller";
import { type LangCode } from "../lib/detection";
import { clearSession, loadSession, scheduleSessionSave } from "../lib/storage";

export interface SyncActions {
  edit: (side: Side, text: string) => void;
  changeLang: (side: Side, lang: LangCode) => void;
  swap: () => void;
  clear: () => void;
  retry: () => void;
  retranslate: () => void;
  toast: (kind: ToastMessage["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  /** Exact sentence alignment for the pane the user is interacting with. */
  alignment: (side: Side) => Alignment | null;
}

const EMPTY_STATE: ControllerState = {
  left: { text: "", lang: "auto", detected: "auto", busy: false },
  right: { text: "", lang: "auto", detected: "auto", busy: false },
  active: null,
  phase: "idle",
  statusText: null,
  provider: null,
  lastElapsedMs: null,
  progress: null,
};

export function useSyncTranslate(): {
  state: ControllerState;
  actions: SyncActions;
  toasts: ToastMessage[];
} {
  const [state, setState] = useState<ControllerState>(EMPTY_STATE);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const controllerRef = useRef<SyncController | null>(null);
  const restoredRef = useRef(false);
  const toastSeqRef = useRef(0);

  const pushToast = useCallback(
    (kind: ToastMessage["kind"], message: string, actionLabel?: string, onAction?: () => void) => {
      const id = ++toastSeqRef.current;
      setToasts((prev) => [...prev.slice(-4), { id, kind, message, actionLabel, onAction }]);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const controller = new SyncController({
      api: createApi(),
      onUpdate: setState,
      onToast: (toast) => setToasts((prev) => [...prev.slice(-4), toast]),
    });
    controllerRef.current = controller;

    // Restore the previous session silently (no automatic re-translation).
    // StrictMode remounts effects in dev; only restore once.
    const saved = !restoredRef.current ? loadSession() : null;
    if (saved) {
      restoredRef.current = true;
      controller.restore(
        { text: saved.left.text, lang: saved.left.lang, detected: "auto", busy: false },
        { text: saved.right.text, lang: saved.right.lang, detected: "auto", busy: false }
      );
      pushToast("info", "已恢复上次的会话内容");
    }
    return () => controller.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the session (throttled) whenever texts or languages change.
  useEffect(() => {
    scheduleSessionSave(
      { text: state.left.text, lang: state.left.lang },
      { text: state.right.text, lang: state.right.lang }
    );
  }, [state.left.text, state.left.lang, state.right.text, state.right.lang]);

  const controller = controllerRef.current;

  const actions: SyncActions = {
    edit: (side, text) => controller?.edit(side, text),
    changeLang: (side, lang) => controller?.changeLang(side, lang),
    swap: () => controller?.swap(),
    clear: () => {
      clearSession();
      controller?.clear();
    },
    retry: () => controller?.retry(),
    retranslate: () => {
      controller?.retranslateAll();
    },
    toast: (kind, message) => pushToast(kind, message),
    dismissToast,
    alignment: (side) => controller?.alignFor(side) ?? null,
  };

  return { state, actions, toasts };
}
