import * as vscode from 'vscode';

interface PushFile {
  path: string;
  label: string;
  status: string; // M, A, D, R, C
}

export class PushConfirmPanel {
  /**
   * Shows a webview panel listing files to be pushed.
   * Resolves `true` if user confirms, `false` if cancelled.
   */
  static show(files: PushFile[], commitCount: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let resolved = false;

      const panel = vscode.window.createWebviewPanel(
        'betterGit.pushConfirm',
        `Push — ${commitCount} commit${commitCount !== 1 ? 's' : ''}, ${files.length} file${files.length !== 1 ? 's' : ''}`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );

      panel.webview.html = buildHtml(files, commitCount);

      panel.webview.onDidReceiveMessage((msg: any) => {
        if (msg.type === 'confirm') {
          resolved = true;
          resolve(true);
          panel.dispose();
        } else if (msg.type === 'cancel') {
          resolved = true;
          resolve(false);
          panel.dispose();
        }
      });

      panel.onDidDispose(() => {
        if (!resolved) { resolve(false); }
      });
    });
  }
}

function statusName(s: string): string {
  switch (s) {
    case 'A': return 'Added';
    case 'M': return 'Modified';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'C': return 'Copied';
    default:  return s;
  }
}

function statusColor(s: string): string {
  // JetBrains-style colors
  switch (s) {
    case 'A': return '#67b86a'; // green — new file
    case 'M': return '#6897dc'; // blue — modified
    case 'D': return '#6c6c6c'; // grey with strikethrough — deleted
    case 'R': return '#5f9ea0'; // teal — renamed
    case 'C': return '#67b86a'; // green — copied
    default:  return 'inherit';
  }
}

function buildHtml(files: PushFile[], commitCount: number): string {
  const nonce = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');

  const fileRows = files.map(f => {
    const color = statusColor(f.status);
    const decoration = f.status === 'D' ? 'text-decoration: line-through;' : '';
    const name = f.label.includes('/') ? f.label.slice(f.label.lastIndexOf('/') + 1) : f.label;
    const dir = f.label.includes('/') ? f.label.slice(0, f.label.lastIndexOf('/')) : '';
    return `
      <tr class="file-row">
        <td class="status-cell" style="color:${color}; font-weight:700;">${f.status}</td>
        <td class="name-cell" style="color:${color}; ${decoration}">${esc(name)}</td>
        <td class="dir-cell">${esc(dir)}</td>
      </tr>`;
  }).join('');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px;
}
h2 {
  margin-bottom: 4px;
  font-size: 15px;
  font-weight: 600;
}
.subtitle {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  margin-bottom: 16px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 20px;
}
.file-row td {
  padding: 3px 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--vscode-widget-border, #ffffff10);
}
.file-row:hover td {
  background: var(--vscode-list-hoverBackground);
}
.status-cell {
  width: 24px;
  text-align: center;
  font-family: monospace;
}
.name-cell {
  white-space: nowrap;
}
.dir-cell {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  padding-left: 12px;
}
.buttons {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.btn {
  padding: 6px 20px;
  border: none;
  border-radius: 3px;
  font-size: 13px;
  font-family: var(--vscode-font-family);
  cursor: pointer;
}
.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

.legend {
  display: flex;
  gap: 16px;
  margin-bottom: 14px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
}
</style>
</head>
<body>

<h2>Push Changes</h2>
<p class="subtitle">${commitCount} commit${commitCount !== 1 ? 's' : ''} · ${files.length} file${files.length !== 1 ? 's' : ''} changed</p>

<div class="legend">
  <span class="legend-item"><span class="legend-dot" style="background:#67b86a"></span> Added</span>
  <span class="legend-item"><span class="legend-dot" style="background:#6897dc"></span> Modified</span>
  <span class="legend-item"><span class="legend-dot" style="background:#6c6c6c"></span> Deleted</span>
  <span class="legend-item"><span class="legend-dot" style="background:#5f9ea0"></span> Renamed</span>
</div>

<table>
  <tbody>${fileRows}</tbody>
</table>

<div class="buttons">
  <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
  <button class="btn btn-primary" id="push-btn">Push</button>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  document.getElementById('push-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'confirm' });
  });
  document.getElementById('cancel-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
}());
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
