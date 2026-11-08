import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

/**
 * One CodeMirror instance per open tab. The Yjs binding supplies remote
 * cursors/selections and merges edits; we only own the chrome.
 *
 * `yCollab` deliberately does not register undo keybindings, while `basicSetup`
 * brings CodeMirror's own history — so the Yjs keymap is installed at the
 * highest precedence, otherwise Cmd-Z would undo against the wrong stack.
 */
const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: '#000000',
      color: '#e5e5e5',
    },
    '.cm-scroller': {
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: '1.65',
      padding: '10px 0 40vh',
    },
    '.cm-content': { caretColor: '#818cf8', padding: '0 10px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#3a3a3a',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: '#808080',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(129, 140, 248, 0.22)',
    },
    '.cm-cursor': { borderLeftColor: '#818cf8' },
    '.cm-panels': { backgroundColor: '#0a0a0a', color: '#e5e5e5' },
    '.cm-tooltip': {
      backgroundColor: '#141414',
      border: '1px solid #2a2a2a',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

export function createEditor(
  host: HTMLElement,
  ytext: Y.Text,
  awareness: Awareness,
  undoManager: Y.UndoManager,
): EditorView {
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        Prec.highest(keymap.of(yUndoManagerKeymap)),
        basicSetup,
        theme,
        EditorView.lineWrapping,
        yCollab(ytext, awareness, { undoManager }),
      ],
    }),
  })
}
