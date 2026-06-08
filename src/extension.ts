import * as vscode from 'vscode';
import { GitConflictError, GitService, PullStrategy } from './gitService';
import { BetterGitViewProvider } from './BetterGitViewProvider';
import { PushConfirmPanel } from './PushConfirmPanel';
import { showBranchPicker } from './BranchPicker';
import { ConflictResolverPanel } from './ConflictResolverPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitService = new GitService(context);
  await gitService.init();
  // No popup if no repo yet — the git extension may discover it later
  // (gitService keeps a listener alive). The webview itself shows a
  // "No git repository found" message while we wait.

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

  function configuredPullStrategy(): PullStrategy {
    const value = vscode.workspace
      .getConfiguration('betterGit')
      .get<string>('pullStrategy', 'merge');
    return value === 'rebase' || value === 'ffOnly' ? value : 'merge';
  }

  async function handleGitError(label: string, e: any): Promise<void> {
    const conflictedFiles = e instanceof GitConflictError ? e.conflictedFiles : e?.conflictedFiles;
    if (conflictedFiles?.length) {
      vscode.window.showWarningMessage(
        `${label} stopped with conflicts in ${plural(conflictedFiles.length, 'file')}.`
      );
      await ConflictResolverPanel.show(gitService);
      return;
    }
    vscode.window.showErrorMessage(`${label} failed: ${e.message ?? e}`);
  }

  async function runPull(strategy: PullStrategy): Promise<void> {
    provider.setLoading(true, strategy === 'rebase' ? 'Pulling with rebase…' : 'Pulling…');
    try {
      const stats = await gitService.pullWithStats(strategy);
      if (stats.alreadyUpToDate) {
        vscode.window.showInformationMessage('Already up to date.');
      } else {
        vscode.window.showInformationMessage(
          `Pulled ${plural(stats.commits, 'commit')}, ${plural(stats.files, 'file')} updated.`
        );
      }
    } catch (e: any) {
      await handleGitError('Pull', e);
    } finally {
      provider.setLoading(false);
    }
  }

  async function silentFetch(): Promise<void> {
    if (!gitService.hasRepo()) { return; }
    try {
      await gitService.fetch();
    } catch {
      // Background fetch should only update ahead/behind indicators when it works.
    }
  }

  const cfg = vscode.workspace.getConfiguration('betterGit');
  if (cfg.get<boolean>('autoFetch', true)) {
    void silentFetch();
    const intervalSeconds = Math.max(60, cfg.get<number>('autoFetchIntervalSeconds', 300));
    const timer = setInterval(() => void silentFetch(), intervalSeconds * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('betterGit.fetch',
      () => withLoading('Fetching…', async () => {
        try { await gitService.fetch(); }
        catch (e: any) { vscode.window.showErrorMessage(`Fetch failed: ${e.message ?? e}`); }
      })),

    vscode.commands.registerCommand('betterGit.pull',
      () => runPull(configuredPullStrategy())),

    vscode.commands.registerCommand('betterGit.pullMerge',
      () => runPull('merge')),

    vscode.commands.registerCommand('betterGit.pullRebase',
      () => runPull('rebase')),

    vscode.commands.registerCommand('betterGit.pullFastForward',
      () => runPull('ffOnly')),

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
        await handleGitError('Push', e);
      } finally {
        provider.setLoading(false);
      }
    }),

    vscode.commands.registerCommand('betterGit.refresh',      () => provider.refresh()),
    vscode.commands.registerCommand('betterGit.switchBranch', () => showBranchPicker(gitService)),
    vscode.commands.registerCommand('betterGit.resolveConflicts', () => ConflictResolverPanel.show(gitService)),
  );
}

export function deactivate(): void {}
