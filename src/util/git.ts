import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class WorktreeCreationError extends Error {}

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
