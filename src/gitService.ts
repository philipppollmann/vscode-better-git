import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type PullStrategy = 'merge' | 'rebase' | 'ffOnly';

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
  conflicts: FileChange[];
  staged: FileChange[];
  unstaged: FileChange[];
}

export interface PullStats {
  commits: number;
  files: number;
  alreadyUpToDate: boolean;
}

export interface ConflictSummary {
  path: string;
  label: string;
  conflictCount: number;
}

export interface ConflictBlock {
  id: number;
  startLine: number;
  oursLabel: string;
  theirsLabel: string;
  baseLabel?: string;
  ours: string[];
  theirs: string[];
  base?: string[];
}

export interface ConflictFile {
  path: string;
  label: string;
  blocks: ConflictBlock[];
}

export interface ConflictResolution {
  id: number;
  choice: 'ours' | 'theirs' | 'both' | 'custom';
  customLines?: string[];
}

export type GitOperationState = 'merge' | 'rebase' | 'cherryPick';

export interface BranchInfo {
  name: string;          // 'main' or 'origin/main'
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: number;    // unix timestamp
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

function isConflictStatus(status: number): boolean {
  return status >= 12 && status <= 18;
}

export class GitConflictError extends Error {
  constructor(message: string, readonly conflictedFiles: ConflictSummary[]) {
    super(message);
    this.name = 'GitConflictError';
  }
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

    // Keep listening for repositories opened later — the git extension can
    // take a while to discover a repo (slow indexing, late-opened folder).
    // Without this, the view stays stuck on "No git repository found".
    this._context.subscriptions.push(
      api.onDidOpenRepository((repo: any) => this._adoptRepo(repo))
    );

    if (api.repositories.length > 0) {
      this._adoptRepo(api.repositories[0]);
      return true;
    }

    // No repo yet — wait briefly, but don't give up permanently if it
    // doesn't appear: the listener above will pick it up later.
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3000);
      const d = api.onDidOpenRepository(() => {
        clearTimeout(timer);
        d.dispose();
        resolve();
      });
    });

    if (api.repositories.length > 0 && !this._repo) {
      this._adoptRepo(api.repositories[0]);
    }
    return !!this._repo;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _adoptRepo(repo: any): void {
    if (this._repo || !repo) { return; }
    this._repo = repo;
    this._context.subscriptions.push(
      repo.state.onDidChange(() => this.onDidChange.fire())
    );
    this.onDidChange.fire();
  }

  hasRepo(): boolean { return !!this._repo; }

  getState(): RepoState | null {
    if (!this._repo) { return null; }
    const s = this._repo.state;

    const mapChange = (c: any): FileChange => ({
      path: c.uri.fsPath,
      label: vscode.workspace.asRelativePath(c.uri, false),
      statusLabel: statusLabel(c.status),
      status: c.status,
    });

    const staged = (s.indexChanges as any[]).map(mapChange);
    const unstaged = (s.workingTreeChanges as any[]).map(mapChange);
    const mergeChanges = ((s.mergeChanges as any[] | undefined) ?? []).map(mapChange);
    const conflictsByPath = new Map<string, FileChange>();
    for (const c of [...mergeChanges, ...staged, ...unstaged]) {
      if (isConflictStatus(c.status)) {
        conflictsByPath.set(c.path, c);
      }
    }

    return {
      branch:   s.HEAD?.name ?? '(detached)',
      ahead:    s.HEAD?.ahead  ?? 0,
      behind:   s.HEAD?.behind ?? 0,
      conflicts: Array.from(conflictsByPath.values()),
      staged: staged.filter(c => !isConflictStatus(c.status)),
      unstaged: unstaged.filter(c => !isConflictStatus(c.status)),
    };
  }

  async stageFile(uri: vscode.Uri): Promise<void> {
    await this._repo.add([uri.fsPath]);
  }

  async unstageFile(uri: vscode.Uri): Promise<void> {
    await this._repo.revert([uri.fsPath]);
  }

  async stageAll(): Promise<void> {
    const paths = (this._repo.state.workingTreeChanges as any[])
      .filter((c: any) => !isConflictStatus(c.status))
      .map((c: any) => c.uri.fsPath);
    if (paths.length) { await this._repo.add(paths); }
  }

  async unstageAll(): Promise<void> {
    const paths = (this._repo.state.indexChanges as any[]).map((c: any) => c.uri.fsPath);
    if (paths.length) { await this._repo.revert(paths); }
  }

  async commit(message: string, amend: boolean): Promise<void> {
    await this._repo.commit(message, { amend });
  }

  private ensureRepo(): any {
    if (!this._repo) {
      throw new Error('No git repository found.');
    }
    return this._repo;
  }

  private get repoRoot(): string {
    return this.ensureRepo().rootUri.fsPath;
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.repoRoot,
        maxBuffer: 20 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (e: any) {
      const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
      const stdout = typeof e.stdout === 'string' ? e.stdout.trim() : '';
      const details = [stderr, stdout].filter(Boolean).join('\n').trim();
      throw new Error(details || e.message || `git ${args.join(' ')} failed`);
    }
  }

  private async refreshRepoState(): Promise<void> {
    try {
      await this._repo?.status?.();
    } catch {
      // The VS Code git extension also observes the repository; this is only
      // a best-effort nudge so the Better Git view updates immediately.
    }
    this.onDidChange.fire();
  }

  private async runPossiblyConflictingGit(args: string[]): Promise<string> {
    try {
      const out = await this.git(...args);
      await this.refreshRepoState();
      return out;
    } catch (e: any) {
      await this.refreshRepoState();
      const conflicts = await this.getConflictSummaries();
      if (conflicts.length > 0) {
        throw new GitConflictError(e.message ?? String(e), conflicts);
      }
      throw e;
    }
  }

  async fetch():  Promise<void> {
    await this.git('fetch', '--prune');
    await this.refreshRepoState();
  }

  async pull(strategy: PullStrategy = 'merge'): Promise<void> {
    await this.pullWithStats(strategy);
  }

  async push():   Promise<void> { await vscode.commands.executeCommand('git.push');  }

  async pullWithStats(strategy: PullStrategy = 'merge'): Promise<PullStats> {
    const headBefore = await this.git('rev-parse', 'HEAD');
    await this.runPossiblyConflictingGit(this.pullArgs(strategy));
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

  private pullArgs(strategy: PullStrategy): string[] {
    switch (strategy) {
      case 'rebase':
        return ['pull', '--rebase', '--autostash'];
      case 'ffOnly':
        return ['pull', '--ff-only'];
      case 'merge':
      default:
        return ['pull', '--no-rebase', '--autostash', '--no-edit'];
    }
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

  // -------- Branch management --------

  async listBranches(): Promise<BranchInfo[]> {
    const fmt = '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)';
    const out = await this.git(
      'for-each-ref',
      `--format=${fmt}`,
      'refs/heads',
      'refs/remotes'
    );
    if (!out) { return []; }

    const branches: BranchInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) { continue; }
      const [refname, short, head, upstream, track, date] = line.split('\0');
      const isRemote = refname.startsWith('refs/remotes/');
      // Skip remote HEAD pseudo-ref like 'origin/HEAD'
      if (isRemote && short.endsWith('/HEAD')) { continue; }

      let ahead = 0;
      let behind = 0;
      if (track) {
        const a = track.match(/ahead (\d+)/);
        const b = track.match(/behind (\d+)/);
        if (a) { ahead = parseInt(a[1], 10); }
        if (b) { behind = parseInt(b[1], 10); }
      }

      branches.push({
        name: short,
        isCurrent: head === '*',
        isRemote,
        upstream: upstream || null,
        ahead,
        behind,
        lastCommit: parseInt(date, 10) || 0,
      });
    }
    return branches;
  }

  async getDefaultBranch(): Promise<string> {
    // Try origin's HEAD pointer first
    try {
      const ref = await this.git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
      return ref.replace(/^origin\//, '');
    } catch {
      // Fall back to common defaults
      for (const candidate of ['main', 'master']) {
        try {
          await this.git('rev-parse', '--verify', candidate);
          return candidate;
        } catch { /* keep trying */ }
      }
      return 'main';
    }
  }

  async checkoutBranch(name: string, isRemote: boolean): Promise<void> {
    if (isRemote) {
      // e.g. 'origin/feature/x' -> local 'feature/x'
      const local = name.replace(/^[^/]+\//, '');
      // If local branch already exists, just check it out
      try {
        await this.git('rev-parse', '--verify', `refs/heads/${local}`);
        await this.git('checkout', local);
      } catch {
        await this.git('checkout', '-b', local, '--track', name);
      }
    } else {
      await this.git('checkout', name);
    }
    await this.refreshRepoState();
  }

  async createBranch(name: string, fromRef?: string): Promise<void> {
    if (fromRef) {
      await this.git('checkout', '-b', name, fromRef);
    } else {
      await this.git('checkout', '-b', name);
    }
    await this.refreshRepoState();
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.git('branch', force ? '-D' : '-d', name);
    await this.refreshRepoState();
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git('branch', '-m', oldName, newName);
    await this.refreshRepoState();
  }

  async mergeInto(source: string): Promise<void> {
    await this.runPossiblyConflictingGit(['merge', '--no-edit', source]);
  }

  async rebaseOnto(target: string): Promise<void> {
    await this.runPossiblyConflictingGit(['rebase', '--autostash', target]);
  }

  // -------- Conflict resolution --------

  async getConflictSummaries(): Promise<ConflictSummary[]> {
    const relPaths = await this.getConflictedRelativePaths();
    const root = this.repoRoot;
    const summaries: ConflictSummary[] = [];

    for (const rel of relPaths) {
      const abs = path.resolve(root, rel);
      let conflictCount = 0;
      try {
        const text = await fs.readFile(abs, 'utf8');
        conflictCount = parseConflictBlocks(text).length;
      } catch {
        // Binary/delete conflicts do not have textual conflict markers.
      }
      summaries.push({
        path: abs,
        label: rel,
        conflictCount,
      });
    }

    return summaries;
  }

  async getConflictFiles(): Promise<ConflictFile[]> {
    const relPaths = await this.getConflictedRelativePaths();
    const root = this.repoRoot;
    const files: ConflictFile[] = [];

    for (const rel of relPaths) {
      const abs = path.resolve(root, rel);
      let blocks: ConflictBlock[] = [];
      try {
        const text = await fs.readFile(abs, 'utf8');
        blocks = parseConflictBlocks(text).map(stripParserMetadata);
      } catch {
        // Binary/delete conflicts are still shown, but need the regular editor.
      }
      files.push({ path: abs, label: rel, blocks });
    }

    return files;
  }

  async resolveConflictFile(fsPath: string, resolutions: ConflictResolution[]): Promise<void> {
    const abs = this.assertInsideRepo(fsPath);
    const text = await fs.readFile(abs, 'utf8');
    const { lines, eol } = splitText(text);
    const blocks = parseConflictBlocks(text);

    if (blocks.length === 0) {
      throw new Error('No text conflict markers found in this file.');
    }

    const byId = new Map(resolutions.map(r => [r.id, r]));
    const merged: string[] = [];
    let cursor = 0;

    for (const block of blocks) {
      while (cursor < block.startIndex) {
        merged.push(lines[cursor]);
        cursor += 1;
      }

      const resolution = byId.get(block.id);
      if (!resolution) {
        throw new Error(`Missing resolution for conflict at line ${block.startLine}.`);
      }
      merged.push(...linesForResolution(block, resolution));
      cursor = block.endIndex + 1;
    }

    while (cursor < lines.length) {
      merged.push(lines[cursor]);
      cursor += 1;
    }

    await fs.writeFile(abs, merged.join(eol), 'utf8');
    await this.git('add', '--', abs);
    await this.refreshRepoState();
  }

  async getOperationState(): Promise<GitOperationState | null> {
    const gitDir = await this.getGitDir();
    if (await exists(path.join(gitDir, 'rebase-merge')) || await exists(path.join(gitDir, 'rebase-apply'))) {
      return 'rebase';
    }
    if (await exists(path.join(gitDir, 'MERGE_HEAD'))) {
      return 'merge';
    }
    if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return 'cherryPick';
    }
    return null;
  }

  async completeCurrentOperation(): Promise<GitOperationState> {
    const conflicts = await this.getConflictSummaries();
    if (conflicts.length > 0) {
      throw new Error(`${conflicts.length} conflicted file${conflicts.length !== 1 ? 's' : ''} still need resolution.`);
    }

    const op = await this.getOperationState();
    if (!op) {
      throw new Error('No merge, rebase, or cherry-pick operation is in progress.');
    }

    if (op === 'rebase') {
      await this.runPossiblyConflictingGit(['-c', 'core.editor=true', 'rebase', '--continue']);
    } else if (op === 'merge') {
      await this.git('commit', '--no-edit');
      await this.refreshRepoState();
    } else {
      await this.runPossiblyConflictingGit(['-c', 'core.editor=true', 'cherry-pick', '--continue']);
    }

    return op;
  }

  async abortCurrentOperation(): Promise<GitOperationState> {
    const op = await this.getOperationState();
    if (!op) {
      throw new Error('No merge, rebase, or cherry-pick operation is in progress.');
    }

    if (op === 'rebase') {
      await this.git('rebase', '--abort');
    } else if (op === 'merge') {
      await this.git('merge', '--abort');
    } else {
      await this.git('cherry-pick', '--abort');
    }
    await this.refreshRepoState();
    return op;
  }

  private async getConflictedRelativePaths(): Promise<string[]> {
    try {
      const out = await this.git('diff', '--name-only', '-z', '--diff-filter=U');
      return out.split('\0').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async getGitDir(): Promise<string> {
    const gitDir = await this.git('rev-parse', '--git-dir');
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(this.repoRoot, gitDir);
  }

  private assertInsideRepo(fsPath: string): string {
    const root = path.resolve(this.repoRoot);
    const abs = path.resolve(fsPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Refusing to write outside the repository.');
    }
    return abs;
  }

  async pushBranch(name?: string): Promise<void> {
    if (name) {
      await this.git('push', '-u', 'origin', name);
      await this.refreshRepoState();
    } else {
      await vscode.commands.executeCommand('git.push');
    }
  }
}

interface ParsedConflictBlock extends ConflictBlock {
  startIndex: number;
  endIndex: number;
}

function splitText(text: string): { lines: string[]; eol: string } {
  return {
    lines: text.split(/\r?\n/),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function parseConflictBlocks(text: string): ParsedConflictBlock[] {
  const { lines } = splitText(text);
  const blocks: ParsedConflictBlock[] = [];
  let i = 0;
  let id = 1;

  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      i += 1;
      continue;
    }

    const startIndex = i;
    const startLine = i + 1;
    const oursLabel = markerLabel(lines[i], '<<<<<<<', 'Yours');
    i += 1;

    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let baseLabel: string | undefined;

    while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('|||||||')) {
      ours.push(lines[i]);
      i += 1;
    }

    if (i < lines.length && lines[i].startsWith('|||||||')) {
      baseLabel = markerLabel(lines[i], '|||||||', 'Base');
      i += 1;
      while (i < lines.length && !lines[i].startsWith('=======')) {
        base.push(lines[i]);
        i += 1;
      }
    }

    if (i >= lines.length || !lines[i].startsWith('=======')) {
      break;
    }
    i += 1;

    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
      theirs.push(lines[i]);
      i += 1;
    }

    if (i >= lines.length || !lines[i].startsWith('>>>>>>>')) {
      break;
    }

    const theirsLabel = markerLabel(lines[i], '>>>>>>>', 'Incoming');
    const endIndex = i;
    i += 1;

    blocks.push({
      id,
      startLine,
      startIndex,
      endIndex,
      oursLabel,
      theirsLabel,
      baseLabel,
      ours,
      theirs,
      base: base.length ? base : undefined,
    });
    id += 1;
  }

  return blocks;
}

function markerLabel(line: string, marker: string, fallback: string): string {
  const label = line.slice(marker.length).trim();
  return label || fallback;
}

function stripParserMetadata(block: ParsedConflictBlock): ConflictBlock {
  const { startIndex: _startIndex, endIndex: _endIndex, ...publicBlock } = block;
  return publicBlock;
}

function linesForResolution(block: ConflictBlock, resolution: ConflictResolution): string[] {
  switch (resolution.choice) {
    case 'ours':
      return block.ours;
    case 'theirs':
      return block.theirs;
    case 'both':
      return [...block.ours, ...block.theirs];
    case 'custom':
      return resolution.customLines ?? [];
    default:
      return [];
  }
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}
