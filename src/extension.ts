import * as vscode from 'vscode';
import { GitService } from './gitService';
import { BetterGitViewProvider } from './BetterGitViewProvider';
import { PushConfirmPanel } from './PushConfirmPanel';

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

  function plural(n: number, word: string): string {
    return `${n} ${word}${n !== 1 ? 's' : ''}`;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('betterGit.fetch',
      () => withLoading('Fetching…', () => gitService.fetch())),

    vscode.commands.registerCommand('betterGit.pull', async () => {
      provider.setLoading(true, 'Pulling…');
      try {
        const stats = await gitService.pullWithStats();
        if (stats.alreadyUpToDate) {
          vscode.window.showInformationMessage('Already up to date.');
        } else {
          vscode.window.showInformationMessage(
            `Pulled ${plural(stats.commits, 'commit')}, ${plural(stats.files, 'file')} updated.`
          );
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
      } finally {
        provider.setLoading(false);
      }
    }),

    vscode.commands.registerCommand('betterGit.push', async () => {
      try {
        // Show confirmation panel with files to push
        const files = await gitService.getFilesToPush();
        const state = gitService.getState();
        const commitCount = state?.ahead ?? 0;

        if (files.length > 0) {
          const confirmed = await PushConfirmPanel.show(files, commitCount);
          if (!confirmed) { return; }
        }

        provider.setLoading(true, 'Pushing…');
        const stats = await gitService.pushWithStats();
        provider.clearBadge();
        if (stats.commits > 0) {
          vscode.window.showInformationMessage(
            `Pushed ${plural(stats.commits, 'commit')}, ${plural(stats.files, 'file')} changed.`
          );
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Push failed: ${e.message}`);
      } finally {
        provider.setLoading(false);
      }
    }),

    vscode.commands.registerCommand('betterGit.refresh',      () => provider.refresh()),
    vscode.commands.registerCommand('betterGit.switchBranch', () => gitService.switchBranch()),
  );
}

export function deactivate(): void {}
