import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeRemote,
  projectIdentity,
  projectScopeFor,
  scopeKey
} from '../src/store/paths.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-memory-key-'))
}

async function gitRepo(root: string, remote: string | undefined): Promise<void> {
  await mkdir(join(root, '.git'), { recursive: true })
  const config = remote === undefined ? '[core]\n\trepositoryformatversion = 0\n' : `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  await writeFile(join(root, '.git', 'config'), config)
}

describe('normalizeRemote', () => {
  it('normalizes scp-like, https and ssh URLs', () => {
    expect(normalizeRemote('git@github.com:acme/repo.git')).toBe('github.com/acme/repo')
    expect(normalizeRemote('https://github.com/acme/repo.git')).toBe('github.com/acme/repo')
    expect(normalizeRemote('https://user:pass@github.com/acme/repo.git')).toBe('github.com/acme/repo')
    expect(normalizeRemote('ssh://git@github.com/acme/repo.git')).toBe('github.com/acme/repo')
    expect(normalizeRemote('git+https://gitlab.com/group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
  })

  it('keeps the path case and lowercases the host', () => {
    expect(normalizeRemote('git@GitHub.com:Acme/Repo.git')).toBe('github.com/Acme/Repo')
  })
})

describe('projectIdentity', () => {
  it('is stable when the repository moves', async () => {
    const first = await tempDir()
    const second = await tempDir()
    try {
      await gitRepo(first, 'git@github.com:acme/service.git')
      await gitRepo(second, 'git@github.com:acme/service.git')
      expect(projectIdentity(first).key).toBe(projectIdentity(second).key)
      expect(projectIdentity(first).key.startsWith('repo-')).toBe(true)
      expect(projectIdentity(first).label).toBe(projectIdentity(first).root.split(/[\\/]/).pop())
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('gives monorepo subpackages their own key', async () => {
    const root = await tempDir()
    try {
      await gitRepo(root, 'git@github.com:acme/mono.git')
      const sub = join(root, 'packages', 'app')
      await mkdir(sub, { recursive: true })
      expect(projectIdentity(root).key).not.toBe(projectIdentity(sub).key)
      expect(projectIdentity(sub).root).toBe(projectIdentity(root).root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to a path key without git', async () => {
    const first = await tempDir()
    const second = await tempDir()
    try {
      const identity = projectIdentity(first)
      expect(identity.key.startsWith('path-')).toBe(true)
      expect(identity.key).toBe(projectIdentity(first).key)
      expect(identity.key).not.toBe(projectIdentity(second).key)
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('ignores git remotes in path mode', async () => {
    const root = await tempDir()
    try {
      await gitRepo(root, 'git@github.com:acme/service.git')
      expect(projectIdentity(root, 'git').key.startsWith('repo-')).toBe(true)
      expect(projectIdentity(root, 'path').key.startsWith('path-')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves worktree .git files and commondir config', async () => {
    const main = await tempDir()
    const worktree = await tempDir()
    try {
      await mkdir(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
      await writeFile(
        join(main, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/wt.git\n'
      )
      await writeFile(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
      await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
      const identity = projectIdentity(worktree)
      expect(identity.remote).toBe('github.com/acme/wt')
      expect(identity.key.startsWith('repo-')).toBe(true)
      expect(identity.root).toBe(identity.root)
    } finally {
      await rm(main, { recursive: true, force: true })
      await rm(worktree, { recursive: true, force: true })
    }
  })

  it('produces a stable serialized scope key', () => {
    const scope = projectScopeFor(process.cwd(), 'path')
    expect(scopeKey(scope)).toMatch(/^project:path-[0-9a-f]{12}$/)
    expect(scopeKey({ type: 'user' })).toBe('user')
  })

  it('normalizes Windows drive case only on Windows', () => {
    if (process.platform !== 'win32') return
    expect(projectIdentity('C:\\Windows').key).toBe(projectIdentity('c:\\Windows').key)
  })
})
