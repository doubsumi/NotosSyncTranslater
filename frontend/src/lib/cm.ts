// ---------------------------------------------------------------------------
// CodeMirror 6 helpers shared by the two editor panes.
//
// The panes remain *plain text* editors (same SyncController semantics), but
// being CodeMirror gives us native decorations — used for cross-pane sentence
// highlight and caret-sentence flash — instead of fragile textarea tricks.
// ---------------------------------------------------------------------------

import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  type AnnotationType,
  type Extension,
  type StateEffectType,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

export interface TextRange {
  from: number;
  to: number;
}

// Marking transactions we dispatch ourselves (programmatic value sync) so the
// change listener can ignore them (no feedback loop into SyncController).
const externalTag: AnnotationType<boolean> = Annotation.define<boolean>();

export function isExternal(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => tr.annotation(externalTag) === true);
}

/** Atomically replace the whole document without echoing an "edit" event. */
export function applyDocExternally(view: EditorView, next: string): void {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  const head = Math.min(view.state.selection.main.head, next.length);
  view.dispatch({
    changes: { from: 0, to: cur.length, insert: next },
    annotations: externalTag.of(true),
    selection: EditorSelection.cursor(head),
    scrollIntoView: false,
  });
}

// ---------------------------------------------------------------------------
// Decoration fields: one per visual role (link = counterpart, flash = self).
// ---------------------------------------------------------------------------

const linkEffect: StateEffectType<TextRange | null> = StateEffect.define<TextRange | null>();
const flashEffect: StateEffectType<TextRange | null> = StateEffect.define<TextRange | null>();
const linkMark = Decoration.mark({ class: "cm-linked" });
const flashMark = Decoration.mark({ class: "cm-flash" });

function rangeField(
  effectType: StateEffectType<TextRange | null>,
  mark: Decoration
): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
      decorations = decorations.map(tr.changes);
      const hit = tr.effects.find((e) => e.is(effectType));
      if (hit) {
        const range = hit.value as TextRange | null;
        return range
          ? Decoration.set([mark.range(range.from, range.to)])
          : Decoration.none;
      }
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const linkField = rangeField(linkEffect, linkMark);
const flashField = rangeField(flashEffect, flashMark);

/** Set the counterpart sentence highlight of a view (null clears it). */
export function setLinkHighlight(view: EditorView, range: TextRange | null): void {
  view.dispatch({ effects: linkEffect.of(range) });
}

/** Set the transient self "flash" highlight of a view. */
export function setFlashHighlight(view: EditorView, range: TextRange | null): void {
  view.dispatch({ effects: flashEffect.of(range) });
}

// ---------------------------------------------------------------------------
// Appearance — driven by the app's CSS variables so light/dark keep working.
// ---------------------------------------------------------------------------

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--text)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-sans)",
    fontSize: "16px",
    lineHeight: "1.75",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--text)",
    padding: "10px 0",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-weak)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text)",
  },
  ".cm-linked": {
    backgroundColor: "var(--accent-weak)",
    borderRadius: "3px",
  },
  ".cm-flash": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
    borderRadius: "3px",
    transition: "background-color 160ms ease",
  },
});

/** Extensions every editor pane uses. */
export function baseEditorExtensions(ariaLabel: string): Extension[] {
  return [
    EditorView.lineWrapping,
    linkField,
    flashField,
    editorTheme,
    EditorView.contentAttributes.of({
      spellcheck: "false",
      "aria-label": ariaLabel,
    }),
  ];
}
