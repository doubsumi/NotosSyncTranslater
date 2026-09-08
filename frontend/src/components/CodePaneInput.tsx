// A thin React wrapper around a CodeMirror 6 plain-text editor.
//
// - User edits bubble up via onUserEdit (never programmatic syncs).
// - Value prop syncs the doc externally (no feedback loop).
// - `link`/`flash` props drive decorations from the parent App.
// - pointer/focus events notify the parent for sentence linking.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import {
  applyDocPatchExternally,
  baseEditorExtensions,
  isExternal,
  setFlashHighlight,
  setLinkHighlight,
  type TextRange,
} from "../lib/cm";

export interface CodePaneInputProps {
  value: string;
  link: TextRange | null;
  flash: TextRange | null;
  ariaLabel: string;
  onUserEdit: (text: string) => void;
  /** Fired after a pointer interaction (selection or caret placement). */
  onPointer: () => void;
  /** Reports the created/destroyed EditorView for cross-pane wiring. */
  onViewReady: (view: EditorView | null) => void;
}

export function CodePaneInput(props: CodePaneInputProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest props without re-mounting the editor.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: propsRef.current.value,
        extensions: [
          ...baseEditorExtensions(propsRef.current.ariaLabel),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !isExternal(update)) {
              propsRef.current.onUserEdit(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            mouseup: () => {
              propsRef.current.onPointer();
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    propsRef.current.onViewReady(view);
    return () => {
      propsRef.current.onViewReady(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value sync (translations landing in the passive pane, restore…).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== props.value) {
      applyDocPatchExternally(view, props.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  // Decoration updates.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setLinkHighlight(view, props.link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.link]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setFlashHighlight(view, props.flash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.flash]);

  return <div className="cm-host" ref={hostRef} />;
}
