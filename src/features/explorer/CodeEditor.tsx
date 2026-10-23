import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

self.MonacoEnvironment = { getWorker(_id, label) {
  if (label === 'json') return new JsonWorker();
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
  if (['typescript', 'javascript'].includes(label)) return new TsWorker();
  return new EditorWorker();
} };
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false });
}

export default function CodeEditor({ path, value, original, diff, inline = false, navigation, line, onChange, onSave, onBlur, onDiffStats }: {
  path: string; value: string; original: string | null; diff: boolean; line?: number;
  inline?: boolean; navigation?: { direction: 'next' | 'previous'; id: number };
  onChange: (value: string) => void; onSave: () => void; onBlur?: () => void;
  onDiffStats?: (stats: { added: number; removed: number } | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null), callbacks = useRef({ onChange, onSave, onBlur, onDiffStats }); callbacks.current = { onChange, onSave, onBlur, onDiffStats };
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const model = useRef<monaco.editor.ITextModel | null>(null), current = useRef(value); current.current = value;
  const position = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const extension = path.split('.').pop()?.toLowerCase();
    const language = monaco.languages.getLanguages().find(lang => lang.filenames?.includes(path.split('/').pop()!) || lang.extensions?.includes(`.${extension}`))?.id ?? 'plaintext';
    const modified = model.current ?? monaco.editor.createModel(current.current, language); model.current = modified;
    const base = diff ? monaco.editor.createModel(original ?? '', language) : null;
    const options: monaco.editor.IStandaloneEditorConstructionOptions = { theme: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, padding: { top: 12 }, scrollBeyondLastLine: false, wordWrap: 'on', fixedOverflowWidgets: false, renderValidationDecorations: 'off' };
    const view = diff ? monaco.editor.createDiffEditor(host.current, { ...options, originalEditable: false, renderSideBySide: !inline, enableSplitViewResizing: true }) : monaco.editor.create(host.current, { ...options, model: modified });
    if (diff) { diffEditor.current = view as monaco.editor.IStandaloneDiffEditor; diffEditor.current.setModel({ original: base!, modified }); }
    callbacks.current.onDiffStats?.(null);
    const stats = diffEditor.current?.onDidUpdateDiff(() => {
      const changes = diffEditor.current?.getLineChanges();
      if (!changes) { callbacks.current.onDiffStats?.(null); return; }
      let added = 0, removed = 0;
      for (const change of changes) {
        if (change.modifiedEndLineNumber !== 0) added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
        if (change.originalEndLineNumber !== 0) removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
      }
      callbacks.current.onDiffStats?.({ added, removed });
    });
    const editor = diff ? (view as monaco.editor.IStandaloneDiffEditor).getModifiedEditor() : view as monaco.editor.IStandaloneCodeEditor;
    const save = editor.addAction({ id: 'vade.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => callbacks.current.onSave() });
    const subscription = modified.onDidChangeContent(() => callbacks.current.onChange(modified.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)));
    const blur = editor.onDidBlurEditorWidget(() => callbacks.current.onBlur?.());
    if (position.current) editor.restoreViewState(position.current);
    else if (line) { editor.setPosition({ lineNumber: line, column: 1 }); editor.revealLineInCenter(line); }
    editor.focus();
    return () => { position.current = editor.saveViewState(); stats?.dispose(); subscription.dispose(); blur.dispose(); save.dispose(); view.dispose(); base?.dispose(); diffEditor.current = null; };
  }, [path, diff, original, line]);
  useEffect(() => () => { model.current?.dispose(); model.current = null; }, []);
  useEffect(() => { diffEditor.current?.updateOptions({ renderSideBySide: !inline }); }, [inline]);
  useEffect(() => { if (navigation) diffEditor.current?.goToDiff(navigation.direction); }, [navigation]);
  useEffect(() => { if (model.current && model.current.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) !== value) model.current.setValue(value); }, [value]);
  return <div className="workspace-code-editor" ref={host} />;
}
