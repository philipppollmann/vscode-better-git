import * as vscode from 'vscode';
import { GitService } from './gitService';
import { PushConfirmPanel } from './PushConfirmPanel';

export class BetterGitViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _git: GitService
  ) {
    this._git.onDidChange.event(() => this._push());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.type) {
        case 'stageFile':
          try { await this._git.stageFile(vscode.Uri.file(msg.path)); }
          catch (e: any) { vscode.window.showErrorMessage(`Stage failed: ${e.message}`); }
          break;
        case 'unstageFile':
          try { await this._git.unstageFile(vscode.Uri.file(msg.path)); }
          catch (e: any) { vscode.window.showErrorMessage(`Unstage failed: ${e.message}`); }
          break;
        case 'stageAll':
          try { await this._git.stageAll(); }
          catch (e: any) { vscode.window.showErrorMessage(`Stage All failed: ${e.message}`); }
          break;
        case 'unstageAll':
          try { await this._git.unstageAll(); }
          catch (e: any) { vscode.window.showErrorMessage(`Unstage All failed: ${e.message}`); }
          break;
        case 'openDiff':
          await this._git.openDiff(msg.path);
          break;
        case 'commit': {
          if (!msg.message?.trim()) {
            vscode.window.showErrorMessage('Better Git: Commit message cannot be empty.');
            return;
          }
          try {
            await this._git.commit(msg.message, msg.amend ?? false);
            this._view?.webview.postMessage({ type: 'clearCommitMessage' });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Commit failed: ${e.message}`);
          }
          break;
        }
        case 'commitAndPush': {
          if (!msg.message?.trim()) {
            vscode.window.showErrorMessage('Better Git: Commit message cannot be empty.');
            return;
          }
          try {
            await this._git.commit(msg.message, msg.amend ?? false);
            this._view?.webview.postMessage({ type: 'clearCommitMessage' });

            // Gather files to push and show confirmation panel
            const files = await this._git.getFilesToPush();
            const state = this._git.getState();
            const commitCount = state?.ahead ?? 0;

            if (files.length > 0) {
              const confirmed = await PushConfirmPanel.show(files, commitCount);
              if (!confirmed) { break; }
            }

            this.setLoading(true, 'Pushing…');
            const stats = await this._git.pushWithStats();
            this._clearBadge();
            if (stats.commits > 0) {
              const c = stats.commits;
              const f = stats.files;
              vscode.window.showInformationMessage(
                `Pushed ${c} commit${c !== 1 ? 's' : ''}, ${f} file${f !== 1 ? 's' : ''} changed.`
              );
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Commit & Push failed: ${e.message}`);
          } finally {
            this.setLoading(false);
          }
          break;
        }
        case 'switchBranch':
          await vscode.commands.executeCommand('betterGit.switchBranch');
          break;
      }
    });

    this._push();
  }

  refresh(): void { this._push(); }

  clearBadge(): void { this._clearBadge(); }

  private _clearBadge(): void {
    if (this._view) {
      this._view.badge = undefined;
    }
  }

  setLoading(loading: boolean, label?: string): void {
    this._view?.webview.postMessage({ type: 'setLoading', loading, label: label ?? '' });
  }

  private _push(): void {
    if (!this._view) { return; }
    const state = this._git.getState();

    // Update activity bar badge with total number of changes
    const total = (state?.staged.length ?? 0) + (state?.unstaged.length ?? 0);
    this._view.badge = total > 0
      ? { value: total, tooltip: `${total} change${total !== 1 ? 's' : ''}` }
      : undefined;

    this._view.webview.postMessage({ type: 'stateUpdate', state });
  }

  private _buildHtml(): string {
    const nonce = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Better Git</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* ---- Branch bar ---- */
#branch-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #0003));
  flex-shrink: 0;
  min-height: 28px;
}

#branch-icon { opacity: 0.7; flex-shrink: 0; }

#branch-name {
  font-weight: 600;
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  font-size: 12px;
}
#branch-name:hover { text-decoration: underline; }

#sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  flex-shrink: 0;
}

.sync-ahead { color: var(--vscode-descriptionForeground); }

.sync-behind {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: default;
}
.sync-behind[title]:hover { opacity: 0.85; }

/* ---- Loading spinner ---- */
@keyframes spin { to { transform: rotate(360deg); } }

#loading-bar {
  display: none;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-sideBar-background);
  border-bottom: 1px solid var(--vscode-widget-border, #0002);
  flex-shrink: 0;
}
#loading-bar.visible { display: flex; }

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--vscode-progressBar-background, #0e70c0);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
  flex-shrink: 0;
}

/* ---- Scrollable area ---- */
#scroll-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
#scroll-area::-webkit-scrollbar { width: 6px; }
#scroll-area::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 3px;
}
#scroll-area::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}

/* ---- Section headers ---- */
.section-header {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #0002));
  cursor: pointer;
  user-select: none;
  gap: 4px;
  min-height: 24px;
}
.section-header:hover { background: var(--vscode-list-hoverBackground); }

.chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  transition: transform 0.12s;
  opacity: 0.7;
  pointer-events: none;
}
.chevron.collapsed { transform: rotate(-90deg); }

.section-title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
  pointer-events: none;
}

.section-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  pointer-events: none;
}

.section-action {
  font-size: 11px;
  padding: 1px 7px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.4;
  /* Ensure clicks on child text still register as button clicks */
  pointer-events: all;
}
.section-action:hover { background: var(--vscode-button-secondaryHoverBackground); }
.section-action:active { filter: brightness(0.9); }

/* ---- File list ---- */
.file-list { list-style: none; }

.file-item {
  display: flex;
  align-items: center;
  padding: 2px 8px 2px 22px;
  gap: 5px;
  cursor: pointer;
  min-height: 20px;
}
.file-item:hover { background: var(--vscode-list-hoverBackground); }

.file-status {
  font-size: 11px;
  font-weight: 700;
  width: 12px;
  text-align: center;
  flex-shrink: 0;
  font-family: monospace;
}
.s-M { color: var(--vscode-gitDecoration-modifiedResourceForeground,  #E2C08D); }
.s-A { color: var(--vscode-gitDecoration-addedResourceForeground,     #81B88B); }
.s-D { color: var(--vscode-gitDecoration-deletedResourceForeground,   #C74E39); }
.s-R { color: var(--vscode-gitDecoration-renamedResourceForeground,   #73C991); }
.s-U { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73C991); }
.s-C { color: var(--vscode-gitDecoration-conflictingResourceForeground, #E4676B); }
.s-B { color: var(--vscode-gitDecoration-conflictingResourceForeground, #E4676B); }

.file-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}
.file-dir {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 2;
  min-width: 0;
}

.stage-btn {
  visibility: hidden;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0.8;
}
.file-item:hover .stage-btn { visibility: visible; }
.stage-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  opacity: 1;
}

.empty-msg {
  padding: 4px 8px 4px 22px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* ---- Commit area ---- */
#commit-area {
  flex-shrink: 0;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--vscode-widget-border, #0002);
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--vscode-sideBar-background);
}

#commit-msg {
  width: 100%;
  min-height: 60px;
  resize: vertical;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  padding: 5px 7px;
}
#commit-msg:focus {
  outline: 1px solid var(--vscode-focusBorder);
  border-color: var(--vscode-focusBorder);
}
#commit-msg::placeholder { color: var(--vscode-input-placeholderForeground); }

#amend-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
}

#commit-buttons {
  display: flex;
  gap: 6px;
}

.btn {
  flex: 1;
  padding: 4px 6px;
  border: none;
  border-radius: 3px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--vscode-font-family);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn:active { filter: brightness(0.9); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

#no-repo {
  padding: 20px 10px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  font-size: 12px;
}
</style>
</head>
<body>

<div id="branch-bar">
  <svg id="branch-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="5"  cy="3"  r="1.5" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="5"  cy="13" r="1.5" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="11" cy="7"  r="1.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="5" y1="4.5"  x2="5"   y2="8"    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="5" y1="8"    x2="9.5" y2="6.5"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="5" y1="8"    x2="5"   y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
  <span id="branch-name">Loading…</span>
  <span id="sync-info"></span>
</div>

<div id="loading-bar">
  <div class="spinner"></div>
  <span id="loading-label">Loading…</span>
</div>

<div id="scroll-area">
  <div id="no-repo" style="display:none">No git repository found.</div>

  <div class="section-header" id="staged-hdr">
    <svg class="chevron" id="staged-chv" viewBox="0 0 16 16">
      <path d="M4 5.5l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="section-title">Staged Changes</span>
    <span class="section-count" id="staged-cnt"></span>
    <button class="section-action" id="unstage-all-btn">Unstage All</button>
  </div>
  <ul class="file-list" id="staged-list"></ul>

  <div class="section-header" id="unstaged-hdr">
    <svg class="chevron" id="unstaged-chv" viewBox="0 0 16 16">
      <path d="M4 5.5l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="section-title">Changes</span>
    <span class="section-count" id="unstaged-cnt"></span>
    <button class="section-action" id="stage-all-btn">Stage All</button>
  </div>
  <ul class="file-list" id="unstaged-list"></ul>
</div>

<div id="commit-area">
  <textarea id="commit-msg" placeholder="Commit message…" spellcheck="false"></textarea>
  <label id="amend-row">
    <input type="checkbox" id="amend-check">
    Amend last commit
  </label>
  <div id="commit-buttons">
    <button class="btn" id="commit-btn">Commit</button>
    <button class="btn" id="commit-push-btn">Commit &amp; Push</button>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);

  const branchName     = el('branch-name');
  const syncInfo       = el('sync-info');
  const loadingBar     = el('loading-bar');
  const loadingLabel   = el('loading-label');
  const stagedList     = el('staged-list');
  const unstagedList   = el('unstaged-list');
  const stagedCnt      = el('staged-cnt');
  const unstagedCnt    = el('unstaged-cnt');
  const stagedHdr      = el('staged-hdr');
  const unstagedHdr    = el('unstaged-hdr');
  const stagedChv      = el('staged-chv');
  const unstagedChv    = el('unstaged-chv');
  const commitMsg      = el('commit-msg');
  const amendCheck     = el('amend-check');
  const commitBtn      = el('commit-btn');
  const commitPushBtn  = el('commit-push-btn');
  const noRepo         = el('no-repo');

  let stagedCollapsed   = false;
  let unstagedCollapsed = false;

  // ---- Collapse / expand ----
  function toggleSection(section) {
    if (section === 'staged') {
      stagedCollapsed = !stagedCollapsed;
      stagedList.style.display = stagedCollapsed ? 'none' : '';
      stagedChv.classList.toggle('collapsed', stagedCollapsed);
    } else {
      unstagedCollapsed = !unstagedCollapsed;
      unstagedList.style.display = unstagedCollapsed ? 'none' : '';
      unstagedChv.classList.toggle('collapsed', unstagedCollapsed);
    }
  }

  // KEY FIX: use closest() so clicking button text still matches the button
  stagedHdr.addEventListener('click', e => {
    if (e.target.closest('.section-action')) { return; }
    toggleSection('staged');
  });
  unstagedHdr.addEventListener('click', e => {
    if (e.target.closest('.section-action')) { return; }
    toggleSection('unstaged');
  });

  el('unstage-all-btn').addEventListener('click', e => {
    e.stopPropagation();
    vscode.postMessage({ type: 'unstageAll' });
  });
  el('stage-all-btn').addEventListener('click', e => {
    e.stopPropagation();
    vscode.postMessage({ type: 'stageAll' });
  });

  branchName.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchBranch' });
  });

  commitBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'commit', message: commitMsg.value, amend: amendCheck.checked });
  });
  commitPushBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'commitAndPush', message: commitMsg.value, amend: amendCheck.checked });
  });

  // ---- Helpers ----
  function splitPath(label) {
    const idx = label.lastIndexOf('/');
    if (idx === -1) { return { name: label, dir: '' }; }
    return { name: label.slice(idx + 1), dir: label.slice(0, idx) };
  }

  function makeItem(file, staged) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'file-status s-' + file.statusLabel;
    statusSpan.textContent = file.statusLabel;

    const { name, dir } = splitPath(file.label);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = name;

    const btn = document.createElement('button');
    btn.className = 'stage-btn';
    btn.title = staged ? 'Unstage' : 'Stage';
    btn.textContent = staged ? '\u2212' : '+';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: staged ? 'unstageFile' : 'stageFile', path: file.path });
    });

    li.addEventListener('click', () => {
      vscode.postMessage({ type: 'openDiff', path: file.path, staged });
    });

    li.appendChild(statusSpan);
    li.appendChild(nameSpan);
    if (dir) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'file-dir';
      dirSpan.textContent = dir;
      li.appendChild(dirSpan);
    }
    li.appendChild(btn);
    return li;
  }

  function emptyMsg(text) {
    const li = document.createElement('li');
    li.className = 'empty-msg';
    li.textContent = text;
    return li;
  }

  // ---- Render ----
  function renderState(state) {
    if (!state) {
      noRepo.style.display = '';
      branchName.textContent = 'No repository';
      syncInfo.innerHTML = '';
      stagedList.innerHTML = '';
      unstagedList.innerHTML = '';
      stagedCnt.textContent = '';
      unstagedCnt.textContent = '';
      return;
    }
    noRepo.style.display = 'none';

    branchName.textContent = state.branch;
    branchName.title = 'Switch branch (' + state.branch + ')';

    // Sync info: ahead shown as plain text, behind as highlighted badge
    syncInfo.innerHTML = '';
    if (state.ahead) {
      const s = document.createElement('span');
      s.className = 'sync-ahead';
      s.textContent = '\u2191' + state.ahead;
      syncInfo.appendChild(s);
    }
    if (state.behind) {
      const s = document.createElement('span');
      s.className = 'sync-behind';
      s.title = state.behind + ' commit' + (state.behind !== 1 ? 's' : '') + ' to pull';
      s.textContent = '\u2193' + state.behind;
      syncInfo.appendChild(s);
    }

    // Staged
    stagedCnt.textContent = state.staged.length ? '(' + state.staged.length + ')' : '';
    stagedList.innerHTML = '';
    if (state.staged.length === 0) {
      stagedList.appendChild(emptyMsg('No staged changes'));
    } else {
      state.staged.forEach(f => stagedList.appendChild(makeItem(f, true)));
    }

    // Unstaged
    unstagedCnt.textContent = state.unstaged.length ? '(' + state.unstaged.length + ')' : '';
    unstagedList.innerHTML = '';
    if (state.unstaged.length === 0) {
      unstagedList.appendChild(emptyMsg('No working tree changes'));
    } else {
      state.unstaged.forEach(f => unstagedList.appendChild(makeItem(f, false)));
    }
  }

  // ---- Messages from extension ----
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'stateUpdate':
        renderState(msg.state);
        break;
      case 'clearCommitMessage':
        commitMsg.value = '';
        amendCheck.checked = false;
        break;
      case 'setLoading':
        loadingBar.classList.toggle('visible', msg.loading);
        loadingLabel.textContent = msg.label || 'Loading…';
        commitBtn.disabled     = msg.loading;
        commitPushBtn.disabled = msg.loading;
        break;
    }
  });
}());
</script>
</body>
</html>`;
  }
}
