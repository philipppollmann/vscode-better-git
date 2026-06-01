import * as vscode from 'vscode';
import { BranchInfo, GitService } from './gitService';

interface BranchItem extends vscode.QuickPickItem {
  branch?: BranchInfo;
  isNewBranch?: boolean;
}

const NEW_BRANCH_BTN: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('add'),
  tooltip: 'New branch from current HEAD',
};

const ACTIONS_BTN: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('ellipsis'),
  tooltip: 'Actions',
};

export async function showBranchPicker(git: GitService): Promise<void> {
  const [branches, defaultBranch] = await Promise.all([
    git.listBranches(),
    git.getDefaultBranch(),
  ]);

  const current = branches.find(b => b.isCurrent);
  const local = branches.filter(b => !b.isRemote).sort(sortBranches(current?.name));
  const remote = branches.filter(b => b.isRemote).sort((a, b) => b.lastCommit - a.lastCommit);

  const items: BranchItem[] = [];

  if (local.length) {
    items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
    for (const b of local) { items.push(makeBranchItem(b)); }
  }
  if (remote.length) {
    items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
    for (const b of remote) { items.push(makeBranchItem(b)); }
  }

  const qp = vscode.window.createQuickPick<BranchItem>();
  qp.title = 'Switch Branch';
  qp.placeholder = 'Type to filter, Enter to checkout, click ⋯ for actions';
  qp.matchOnDescription = true;
  qp.items = items;
  qp.buttons = [NEW_BRANCH_BTN];

  qp.onDidTriggerButton(async btn => {
    if (btn === NEW_BRANCH_BTN) {
      qp.hide();
      await createBranchFlow(git);
    }
  });

  qp.onDidTriggerItemButton(async evt => {
    if (evt.button === ACTIONS_BTN && evt.item.branch) {
      qp.hide();
      await showBranchActions(git, evt.item.branch, defaultBranch);
    }
  });

  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (!sel || !sel.branch) { return; }
    if (sel.branch.isCurrent) { return; }
    await runWithProgress(`Checking out ${sel.branch.name}…`, () =>
      git.checkoutBranch(sel.branch!.name, sel.branch!.isRemote)
    );
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}

function sortBranches(currentName: string | undefined) {
  return (a: BranchInfo, b: BranchInfo): number => {
    if (a.name === currentName) { return -1; }
    if (b.name === currentName) { return 1; }
    return b.lastCommit - a.lastCommit;
  };
}

function makeBranchItem(b: BranchInfo): BranchItem {
  const parts: string[] = [];
  if (b.isCurrent) { parts.push('current'); }
  if (b.ahead) { parts.push(`↑${b.ahead}`); }
  if (b.behind) { parts.push(`↓${b.behind}`); }
  const description = parts.join(' · ');

  const iconId = b.isCurrent ? 'star-full' : b.isRemote ? 'cloud' : 'git-branch';

  return {
    label: `$(${iconId}) ${b.name}`,
    description,
    branch: b,
    buttons: [ACTIONS_BTN],
  };
}

// ---------------------- Per-branch actions ----------------------

interface ActionItem extends vscode.QuickPickItem {
  id: string;
}

async function showBranchActions(
  git: GitService,
  branch: BranchInfo,
  defaultBranch: string
): Promise<void> {
  const items = buildActionItems(branch, defaultBranch);

  const pick = await vscode.window.showQuickPick<ActionItem>(items, {
    title: `Actions: ${branch.name}`,
    placeHolder: 'Select an action',
  });
  if (!pick) { return; }

  try {
    await runAction(git, branch, defaultBranch, pick.id);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Action failed: ${e.message ?? e}`);
  }
}

function buildActionItems(b: BranchInfo, def: string): ActionItem[] {
  const items: ActionItem[] = [];

  if (b.isCurrent) {
    items.push({ id: 'pull', label: '$(cloud-download) Pull', detail: 'Fetch and integrate from upstream' });
    items.push({ id: 'push', label: '$(arrow-up) Push',       detail: 'Push current branch to origin' });
    if (def && def !== b.name) {
      items.push({ id: 'mergeFromDefault', label: `$(git-merge) Merge ${def} into this`, detail: `git merge ${def}` });
      items.push({ id: 'rebaseOntoDefault', label: `$(git-pull-request) Rebase onto ${def}`, detail: `git rebase ${def}` });
    }
    items.push({ id: 'rename', label: '$(edit) Rename…' });
    return items;
  }

  if (b.isRemote) {
    items.push({ id: 'checkout',       label: '$(arrow-right) Checkout',                 detail: 'Create local tracking branch' });
    items.push({ id: 'mergeIntoCurrent', label: '$(git-merge) Merge into current',       detail: `git merge ${b.name}` });
    items.push({ id: 'rebaseCurrent',    label: '$(git-pull-request) Rebase current onto this', detail: `git rebase ${b.name}` });
    return items;
  }

  // Other local branch
  items.push({ id: 'checkout',         label: '$(arrow-right) Checkout' });
  items.push({ id: 'mergeIntoCurrent', label: '$(git-merge) Merge into current', detail: `git merge ${b.name}` });
  items.push({ id: 'rebaseCurrent',    label: '$(git-pull-request) Rebase current onto this', detail: `git rebase ${b.name}` });
  items.push({ id: 'push',             label: '$(arrow-up) Push' });
  items.push({ id: 'rename',           label: '$(edit) Rename…' });
  items.push({ id: 'delete',           label: '$(trash) Delete' });
  return items;
}

async function runAction(
  git: GitService,
  b: BranchInfo,
  defaultBranch: string,
  id: string
): Promise<void> {
  switch (id) {
    case 'checkout':
      await runWithProgress(`Checking out ${b.name}…`, () =>
        git.checkoutBranch(b.name, b.isRemote)
      );
      break;

    case 'pull':
      await vscode.commands.executeCommand('betterGit.pull');
      break;

    case 'push':
      if (b.isCurrent) {
        await vscode.commands.executeCommand('betterGit.push');
      } else {
        await runWithProgress(`Pushing ${b.name}…`, () => git.pushBranch(b.name));
        vscode.window.showInformationMessage(`Pushed ${b.name}.`);
      }
      break;

    case 'mergeFromDefault':
      await runWithProgress(`Merging ${defaultBranch} into ${b.name}…`, () =>
        git.mergeInto(defaultBranch)
      );
      vscode.window.showInformationMessage(`Merged ${defaultBranch} into ${b.name}.`);
      break;

    case 'rebaseOntoDefault':
      await confirmAndRebase(git, b.name, defaultBranch);
      break;

    case 'mergeIntoCurrent':
      await runWithProgress(`Merging ${b.name} into current…`, () => git.mergeInto(b.name));
      vscode.window.showInformationMessage(`Merged ${b.name} into current branch.`);
      break;

    case 'rebaseCurrent':
      await confirmAndRebase(git, 'current', b.name);
      break;

    case 'rename': {
      const newName = await vscode.window.showInputBox({
        title: `Rename ${b.name}`,
        value: b.name,
        prompt: 'New branch name',
        validateInput: v => (v && v.trim() && v !== b.name ? undefined : 'Enter a different valid name'),
      });
      if (!newName) { return; }
      await runWithProgress(`Renaming ${b.name} → ${newName}…`, () =>
        git.renameBranch(b.name, newName.trim())
      );
      break;
    }

    case 'delete': {
      const pick = await vscode.window.showWarningMessage(
        `Delete branch '${b.name}'?`,
        { modal: true },
        'Delete',
        'Force Delete'
      );
      if (!pick) { return; }
      await runWithProgress(`Deleting ${b.name}…`, () =>
        git.deleteBranch(b.name, pick === 'Force Delete')
      );
      vscode.window.showInformationMessage(`Deleted ${b.name}.`);
      break;
    }
  }
}

async function confirmAndRebase(git: GitService, who: string, onto: string): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    `Rebase ${who} onto ${onto}? This rewrites commit history.`,
    { modal: true },
    'Rebase'
  );
  if (ok !== 'Rebase') { return; }
  await runWithProgress(`Rebasing ${who} onto ${onto}…`, () => git.rebaseOnto(onto));
  vscode.window.showInformationMessage(`Rebased ${who} onto ${onto}.`);
}

// ---------------------- New branch flow ----------------------

async function createBranchFlow(git: GitService): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'New branch',
    prompt: 'Branch name (created from current HEAD)',
    placeHolder: 'feature/my-feature',
    validateInput: v => (v && v.trim() ? undefined : 'Name required'),
  });
  if (!name) { return; }
  await runWithProgress(`Creating ${name.trim()}…`, () => git.createBranch(name.trim()));
  vscode.window.showInformationMessage(`Created and switched to ${name.trim()}.`);
}

// ---------------------- Helpers ----------------------

function runWithProgress<T>(title: string, fn: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    fn
  );
}
