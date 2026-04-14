import * as vscode from 'vscode';
import { GitService } from './gitService';
import { BetterGitViewProvider } from './BetterGitViewProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitService = new GitService(context);
  const ok = await gitService.init();

  if (!ok) {
    vscode.window.showWarningMessage('Better Git: No git repository found.');
  }

  const provider = new BetterGitViewProvider(context.extensionUri, gitService);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('betterGit.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  async function withLoading(label: string, fn: () => Promise<void>) {
    provider.setLoading(true, label);
    try { await fn(); }
    finally { provider.setLoading(false); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('betterGit.fetch',
      () => withLoading('Fetching…', () => gitService.fetch())),
    vscode.commands.registerCommand('betterGit.pull',
      () => withLoading('Pulling…',  () => gitService.pull())),
    vscode.commands.registerCommand('betterGit.push',
      () => withLoading('Pushing…',  () => gitService.push())),
    vscode.commands.registerCommand('betterGit.refresh',      () => provider.refresh()),
    vscode.commands.registerCommand('betterGit.switchBranch', () => gitService.switchBranch()),
  );
}

export function deactivate(): void {}
