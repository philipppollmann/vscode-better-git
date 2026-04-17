import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface FileChange {
  path: string;        // full fs path (sent to webview via postMessage)
  label: string;       // repo-relative path for display
  statusLabel: string; // 'M', 'A', 'D', 'R', 'U', 'C', 'B', …
  status: number;
}

export interface RepoState {
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
}

function statusLabel(status: number): string {
  const map: Record<number, string> = {
    0: 'M',  // INDEX_MODIFIED
    1: 'A',  // INDEX_ADDED
    2: 'D',  // INDEX_DELETED
    3: 'R',  // INDEX_RENAMED
    4: 'C',  // INDEX_COPIED
    5: 'M',  // MODIFIED
    6: 'D',  // DELETED
    7: 'U',  // UNTRACKED
    8: '!',  // IGNORED
    12: 'C', // ADDED_BY_US (conflict)
    13: 'C', // ADDED_BY_THEM
    14: 'C', // DELETED_BY_US
    15: 'C', // DELETED_BY_THEM
    16: 'B', // BOTH_ADDED
    17: 'B', // BOTH_DELETED
    18: 'B', // BOTH_MODIFIED
  };
  return map[status] ?? '?';
}

export class GitService {
  readonly onDidChange = new vscode.EventEmitter<void>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _repo: any;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  async init(): Promise<boolean> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) { return false; }
    if (!ext.isActive) { await ext.activate(); }

    const api = ext.exports.getAPI(1);

    if (api.repositories.length === 0) {
      await new Promise<void>(resolve => {
        const d = api.onDidOpenRepository(() => { d.dispose(); resolve(); });
        setTimeout(resolve, 3000);
      });
    }

    this._repo = api.repositories[0];
    if (!this._repo) { return false; }

    this._context.subscriptions.push(
      this._repo.state.onDidChange(() => this.onDidChange.fire())
    );
    return true;
  }

  getState(): RepoState | null {
    if (!this._repo) { return null; }
    const s = this._repo.state;

    const mapChange = (c: any): FileChange => ({
      path: c.uri.fsPath,
      label: vscode.workspace.asRelativePath(c.uri, false),
      statusLabel: statusLabel(c.status),
      status: c.status,
    });

    return {
      branch:   s.HEAD?.name ?? '(detached)',
      ahead:    s.HEAD?.ahead  ?? 0,
      behind:   s.HEAD?.behind ?? 0,
      staged:   (s.indexChanges       as any[]).map(mapChange),
      unstaged: (s.workingTreeChanges as any[]).map(mapChange),
    };
  }

  async stageFile(uri: vscode.Uri): Promise<void> {
    await this._repo.add([uri.fsPath]);
  }

  async unstageFile(uri: vscode.Uri): Promise<void> {
    await this._repo.revert([uri.fsPath]);
  }

  async stageAll(): Promise<void> {
    const paths = (this._repo.state.workingTreeChanges as any[]).map((c: any) => c.uri.fsPath);
    if (paths.length) { await this._repo.add(paths); }
  }

  async unstageAll(): Promise<void> {
    const paths = (this._repo.state.indexChanges as any[]).map((c: any) => c.uri.fsPath);
    if (paths.length) { await this._repo.revert(paths); }
  }

  async commit(message: string, amend: boolean): Promise<void> {
    await this._repo.commit(message, { amend });
  }

  private async git(...args: string[]): Promise<string> {
    const cwd = this._repo.rootUri.fsPath;
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  async fetch():  Promise<void> { await vscode.commands.executeCommand('git.fetch'); }
  async pull():   Promise<void> { await vscode.commands.executeCommand('git.pull');  }
  async push():   Promise<void> { await vscode.commands.executeCommand('git.push');  }

  async pullWithStats(): Promise<{ commits: number; files: number; alreadyUpToDate: boolean }> {
    const headBefore = await this.git('rev-parse', 'HEAD');
    await vscode.commands.executeCommand('git.pull');
    const headAfter = await this.git('rev-parse', 'HEAD');

    if (headBefore === headAfter) {
      return { commits: 0, files: 0, alreadyUpToDate: true };
    }

    const logOutput = await this.git('log', '--oneline', `${headBefore}..${headAfter}`);
    const commits = logOutput.split('\n').filter(l => l.trim()).length;

    const diffOutput = await this.git('diff', '--name-only', headBefore, headAfter);
    const files = diffOutput.split('\n').filter(l => l.trim()).length;

    return { commits, files, alreadyUpToDate: false };
  }

  async pushWithStats(): Promise<{ commits: number; files: number }> {
    let commits = 0;
    let files = 0;

    try {
      const upstream = await this.git('rev-parse', '--abbrev-ref', '@{u}');
      const logOutput = await this.git('log', '--oneline', `${upstream}..HEAD`);
      commits = logOutput.split('\n').filter(l => l.trim()).length;

      if (commits > 0) {
        const diffOutput = await this.git('diff', '--name-only', upstream, 'HEAD');
        files = diffOutput.split('\n').filter(l => l.trim()).length;
      }
    } catch {
      commits = this._repo.state.HEAD?.ahead ?? 0;
    }

    await vscode.commands.executeCommand('git.push');
    return { commits, files };
  }

  async getFilesToPush(): Promise<{ path: string; label: string; status: string }[]> {
    try {
      const upstream = await this.git('rev-parse', '--abbrev-ref', '@{u}');
      const diffOutput = await this.git('diff', '--name-status', `${upstream}..HEAD`);
      if (!diffOutput) { return []; }
      return diffOutput.split('\n').filter(l => l.trim()).map(line => {
        const [statusChar, ...rest] = line.split('\t');
        const filePath = rest.join('\t');
        return {
          path: filePath,
          label: filePath,
          status: statusChar.charAt(0), // M, A, D, R, C
        };
      });
    } catch {
      return [];
    }
  }

  async switchBranch(): Promise<void> {
    await vscode.commands.executeCommand('git.checkout');
  }

  async openDiff(fsPath: string): Promise<void> {
    await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(fsPath));
  }
}
