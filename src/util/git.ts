import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class WorktreeCreationError extends Error {}

/** Fixed engine identity for auto-commits — distinct from whatever the
 * repo's own `user.name`/`user.email` are configured to, per the post-M5
 * gaps map's worktree-auto-commit-strategy decision
 * (`.scratch/yak-post-m5/issues/01-worktree-commit-strategy.md`). */
const ENGINE_AUTHOR = ['-c', 'user.name=yak', '-c', 'user.email=engine@yak.local']

/** Stages and commits every change in `repoRoot` under a fixed engine
 * identity, or does nothing if the tree is already clean. Called right
 * before a worktree-isolated `map` step forks its item worktrees off
 * `HEAD`, so those forks see this run's own prior step output — never
 * after every step, and never for anything but that one trigger point. */
export async function commitAllIfDirty(repoRoot: string, message: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot })
  if (stdout.trim() === '') return

  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot })
  await execFileAsync('git', [...ENGINE_AUTHOR, 'commit', '-m', message], { cwd: repoRoot })
}

/** Creates a git worktree at `worktreePath` on a new branch `branchName`,
 * forked from `baseRef`. Relies on git's own lock on `.git/worktrees` for
 * concurrency safety — no serialization on yak's side. */
export async function createWorktree(
  repoRoot: string,
  branchName: string,
  baseRef: string,
  worktreePath: string,
): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], { cwd: repoRoot })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new WorktreeCreationError(
      `failed to create worktree at "${worktreePath}" on branch "${branchName}" from "${baseRef}": ${message}`,
    )
  }
}
