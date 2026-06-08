import * as vscode from 'vscode';
import { ConflictFile, ConflictResolution, GitService } from './gitService';

export class ConflictResolverPanel {
  static async show(git: GitService): Promise<void> {
    const files = await git.getConflictFiles();
    const operation = await git.getOperationState();

    if (files.length === 0) {
      vscode.window.showInformationMessage('Better Git: No merge conflicts found.');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'betterGit.conflictResolver',
      `Resolve Conflicts (${files.length})`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    async function sendState(): Promise<void> {
      const nextFiles = await git.getConflictFiles();
      const nextOperation = await git.getOperationState();
      panel.title = nextFiles.length > 0
        ? `Resolve Conflicts (${nextFiles.length})`
        : 'Resolve Conflicts';
      panel.webview.postMessage({
        type: 'state',
        files: nextFiles,
        operation: nextOperation,
      });
    }

    panel.webview.html = buildHtml(files, operation);

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      try {
        switch (msg.type) {
          case 'refresh':
            await sendState();
            break;
          case 'openFile':
            await vscode.window.showTextDocument(vscode.Uri.file(msg.path));
            break;
          case 'resolveFile': {
            await git.resolveConflictFile(msg.path, msg.resolutions as ConflictResolution[]);
            vscode.window.showInformationMessage('Conflict file resolved and staged.');
            await sendState();
            break;
          }
          case 'complete': {
            const op = await git.completeCurrentOperation();
            vscode.window.showInformationMessage(`${operationName(op)} completed.`);
            panel.dispose();
            break;
          }
          case 'abort': {
            const pick = await vscode.window.showWarningMessage(
              'Abort the current Git operation and discard the merge/rebase state?',
              { modal: true },
              'Abort'
            );
            if (pick !== 'Abort') { return; }
            const op = await git.abortCurrentOperation();
            vscode.window.showInformationMessage(`${operationName(op)} aborted.`);
            panel.dispose();
            break;
          }
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Conflict resolver failed: ${e.message ?? e}`);
        await sendState();
      }
    });
  }
}

function operationName(op: string | null): string {
  switch (op) {
    case 'merge': return 'Merge';
    case 'rebase': return 'Rebase';
    case 'cherryPick': return 'Cherry-pick';
    default: return 'Git operation';
  }
}

function buildHtml(files: ConflictFile[], operation: string | null): string {
  const nonce = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  const initialState = JSON.stringify({ files, operation }).replace(/</g, '\\u003c');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Resolve Conflicts</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  height: 100vh;
  overflow: hidden;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
button {
  font-family: var(--vscode-font-family);
  font-size: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff22);
  background: var(--vscode-sideBarSectionHeader-background);
}
.title {
  flex: 1;
  min-width: 0;
}
h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
#operation-label {
  display: block;
  margin-top: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.btn {
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  padding: 4px 10px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn.primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn.danger { color: var(--vscode-errorForeground); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.layout {
  display: grid;
  grid-template-columns: minmax(180px, 26%) 1fr;
  height: calc(100vh - 46px);
  min-height: 0;
}
.sidebar {
  border-right: 1px solid var(--vscode-widget-border, #ffffff22);
  background: var(--vscode-sideBar-background);
  overflow: auto;
}
.file-btn {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff14);
  padding: 8px 10px;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.file-btn:hover { background: var(--vscode-list-hoverBackground); }
.file-btn.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.file-name {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-meta {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.content {
  overflow: auto;
  min-width: 0;
}
.content-inner {
  padding: 12px;
  max-width: 1280px;
}
.file-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.file-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  padding: 28px;
  color: var(--vscode-descriptionForeground);
}
.conflict {
  border: 1px solid var(--vscode-widget-border, #ffffff22);
  border-radius: 4px;
  margin-bottom: 14px;
  overflow: hidden;
}
.conflict-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff22);
}
.conflict-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
}
.choice {
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  padding: 3px 8px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  cursor: pointer;
}
.choice.active {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff22);
}
.pane:first-child {
  border-right: 1px solid var(--vscode-widget-border, #ffffff22);
}
.pane-title {
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff22);
}
.code {
  margin: 0;
  padding: 4px 0;
  overflow: auto;
  background: var(--vscode-editor-background);
}
.code-row {
  display: grid;
  grid-template-columns: 46px 1fr;
  min-height: 18px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  line-height: 18px;
}
.gutter {
  padding: 0 8px;
  color: var(--vscode-editorLineNumber-foreground);
  text-align: right;
  user-select: none;
}
.line {
  padding: 0 8px 0 0;
  white-space: pre;
}
.result {
  padding: 8px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
}
.result label {
  display: block;
  margin-bottom: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
}
.result textarea {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  padding: 6px 8px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  line-height: 18px;
}
.result textarea:focus {
  outline: 1px solid var(--vscode-focusBorder);
}
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .sidebar { max-height: 150px; border-right: 0; border-bottom: 1px solid var(--vscode-widget-border, #ffffff22); }
  .columns { grid-template-columns: 1fr; }
  .pane:first-child { border-right: 0; border-bottom: 1px solid var(--vscode-widget-border, #ffffff22); }
  .toolbar { flex-wrap: wrap; height: auto; }
  .layout { height: calc(100vh - 76px); }
}
</style>
</head>
<body>
<div class="toolbar">
  <div class="title">
    <h1>Resolve Conflicts</h1>
    <span id="operation-label"></span>
  </div>
  <button class="btn" id="refresh-btn">Refresh</button>
  <button class="btn" id="open-btn">Open File</button>
  <button class="btn danger" id="abort-btn">Abort</button>
  <button class="btn primary" id="complete-btn">Continue</button>
</div>
<div class="layout">
  <aside class="sidebar" id="file-list"></aside>
  <main class="content">
    <div class="content-inner" id="content"></div>
  </main>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const initial = ${initialState};
  const el = id => document.getElementById(id);

  let state = initial;
  let selectedPath = initial.files[0] && initial.files[0].path;
  const resolutions = new Map();

  const operationLabel = el('operation-label');
  const fileList = el('file-list');
  const content = el('content');
  const openBtn = el('open-btn');
  const completeBtn = el('complete-btn');

  el('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  el('abort-btn').addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  completeBtn.addEventListener('click', () => vscode.postMessage({ type: 'complete' }));
  openBtn.addEventListener('click', () => {
    const file = selectedFile();
    if (file) { vscode.postMessage({ type: 'openFile', path: file.path }); }
  });

  window.addEventListener('message', event => {
    if (event.data.type === 'state') {
      state = { files: event.data.files, operation: event.data.operation };
      if (!state.files.some(f => f.path === selectedPath)) {
        selectedPath = state.files[0] && state.files[0].path;
      }
      render();
    }
  });

  function selectedFile() {
    return state.files.find(f => f.path === selectedPath) || state.files[0];
  }

  function opText(op) {
    if (op === 'merge') { return 'Merge in progress'; }
    if (op === 'rebase') { return 'Rebase in progress'; }
    if (op === 'cherryPick') { return 'Cherry-pick in progress'; }
    return 'Git operation in progress';
  }

  function completeText(op) {
    if (op === 'merge') { return 'Commit Merge'; }
    if (op === 'rebase') { return 'Continue Rebase'; }
    if (op === 'cherryPick') { return 'Continue Cherry-pick'; }
    return 'Continue';
  }

  function render() {
    operationLabel.textContent = opText(state.operation);
    completeBtn.textContent = completeText(state.operation);
    fileList.innerHTML = '';

    if (state.files.length === 0) {
      openBtn.disabled = true;
      content.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No conflicted files remain.';
      content.appendChild(empty);
      return;
    }

    openBtn.disabled = false;
    state.files.forEach(file => {
      const btn = document.createElement('button');
      btn.className = 'file-btn' + (file.path === selectedPath ? ' active' : '');
      btn.title = file.label;
      btn.addEventListener('click', () => {
        selectedPath = file.path;
        render();
      });
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.label;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = file.blocks.length + ' conflict' + (file.blocks.length !== 1 ? 's' : '');
      btn.appendChild(name);
      btn.appendChild(meta);
      fileList.appendChild(btn);
    });

    renderFile(selectedFile());
  }

  function renderFile(file) {
    content.innerHTML = '';
    if (!file) { return; }

    const header = document.createElement('div');
    header.className = 'file-header';
    const title = document.createElement('div');
    title.className = 'file-title';
    title.textContent = file.label;
    const save = document.createElement('button');
    save.className = 'btn primary';
    save.textContent = 'Apply & Stage';
    save.disabled = file.blocks.length === 0;
    save.addEventListener('click', () => saveFile(file));
    header.appendChild(title);
    header.appendChild(save);
    content.appendChild(header);

    if (file.blocks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'This conflict has no text markers. Open the file to resolve it manually, then stage it.';
      content.appendChild(empty);
      return;
    }

    file.blocks.forEach(block => content.appendChild(renderBlock(file, block)));
  }

  function renderBlock(file, block) {
    const wrap = document.createElement('section');
    wrap.className = 'conflict';

    const head = document.createElement('div');
    head.className = 'conflict-head';
    const title = document.createElement('div');
    title.className = 'conflict-title';
    title.textContent = 'Conflict ' + block.id + ' · line ' + block.startLine;
    head.appendChild(title);
    [
      ['ours', 'Use Yours'],
      ['theirs', 'Use Incoming'],
      ['both', 'Use Both']
    ].forEach(([choice, label]) => {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.textContent = label;
      btn.addEventListener('click', () => setChoice(file, block, choice));
      head.appendChild(btn);
    });
    wrap.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'columns';
    cols.appendChild(renderPane(block.oursLabel, block.ours, block.startLine + 1));
    cols.appendChild(renderPane(block.theirsLabel, block.theirs, block.startLine + block.ours.length + 2));
    wrap.appendChild(cols);

    const result = document.createElement('div');
    result.className = 'result';
    const label = document.createElement('label');
    label.textContent = 'Result for this block';
    const textarea = document.createElement('textarea');
    textarea.dataset.blockId = String(block.id);
    textarea.spellcheck = false;
    textarea.value = getResultLines(file, block).join('\\n');
    textarea.addEventListener('input', () => {
      setResolution(file, block, { choice: 'custom', customLines: splitLines(textarea.value) });
      updateChoiceButtons(wrap, 'custom');
    });
    result.appendChild(label);
    result.appendChild(textarea);
    wrap.appendChild(result);

    updateChoiceButtons(wrap, getResolution(file, block).choice);
    return wrap;
  }

  function renderPane(title, lines, startLine) {
    const pane = document.createElement('div');
    pane.className = 'pane';
    const paneTitle = document.createElement('div');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = title;
    const pre = document.createElement('pre');
    pre.className = 'code';
    if (lines.length === 0) {
      appendCodeRow(pre, startLine, '');
    } else {
      lines.forEach((line, idx) => appendCodeRow(pre, startLine + idx, line));
    }
    pane.appendChild(paneTitle);
    pane.appendChild(pre);
    return pane;
  }

  function appendCodeRow(parent, number, text) {
    const row = document.createElement('div');
    row.className = 'code-row';
    const gutter = document.createElement('span');
    gutter.className = 'gutter';
    gutter.textContent = String(number);
    const line = document.createElement('span');
    line.className = 'line';
    line.textContent = text || ' ';
    row.appendChild(gutter);
    row.appendChild(line);
    parent.appendChild(row);
  }

  function key(file, block) {
    return file.path + ':' + block.id;
  }

  function getResolution(file, block) {
    const k = key(file, block);
    if (!resolutions.has(k)) {
      resolutions.set(k, { choice: 'ours' });
    }
    return resolutions.get(k);
  }

  function setResolution(file, block, resolution) {
    resolutions.set(key(file, block), resolution);
  }

  function getResultLines(file, block) {
    const res = getResolution(file, block);
    if (res.choice === 'theirs') { return block.theirs; }
    if (res.choice === 'both') { return block.ours.concat(block.theirs); }
    if (res.choice === 'custom') { return res.customLines || []; }
    return block.ours;
  }

  function setChoice(file, block, choice) {
    setResolution(file, block, { choice });
    const textarea = content.querySelector('textarea[data-block-id="' + block.id + '"]');
    if (textarea) {
      textarea.value = getResultLines(file, block).join('\\n');
      updateChoiceButtons(textarea.closest('.conflict'), choice);
    }
  }

  function updateChoiceButtons(conflictEl, choice) {
    if (!conflictEl) { return; }
    Array.from(conflictEl.querySelectorAll('.choice')).forEach(btn => {
      btn.classList.toggle('active', btn.textContent === labelForChoice(choice));
    });
  }

  function labelForChoice(choice) {
    if (choice === 'ours') { return 'Use Yours'; }
    if (choice === 'theirs') { return 'Use Incoming'; }
    if (choice === 'both') { return 'Use Both'; }
    return '';
  }

  function splitLines(value) {
    return value.length === 0 ? [] : value.split(/\\r?\\n/);
  }

  function saveFile(file) {
    const fileResolutions = file.blocks.map(block => {
      const textarea = content.querySelector('textarea[data-block-id="' + block.id + '"]');
      const current = getResolution(file, block);
      if (textarea && textarea.value !== getResultLines(file, block).join('\\n')) {
        return { id: block.id, choice: 'custom', customLines: splitLines(textarea.value) };
      }
      return { id: block.id, choice: current.choice, customLines: current.customLines };
    });
    vscode.postMessage({ type: 'resolveFile', path: file.path, resolutions: fileResolutions });
  }

  render();
}());
</script>
</body>
</html>`;
}
