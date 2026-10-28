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
      backgroundColor: '#0b0d10',
      color: '#e6e9ef',
    },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: '1.65',
      padding: '10px 0 40vh',
    },
    '.cm-content': { caretColor: '#5b8cff', padding: '0 10px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#3d4653',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.025)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: '#5b6472',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(91, 140, 255, 0.22)',
    },
    '.cm-cursor': { borderLeftColor: '#5b8cff' },
    '.cm-panels': { backgroundColor: '#111419', color: '#e6e9ef' },
    '.cm-tooltip': {
      backgroundColor: '#171b22',
      border: '1px solid #222833',
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
