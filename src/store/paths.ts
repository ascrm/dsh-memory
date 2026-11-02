/**
 * Project identity and filesystem layout.
 *
 * A project is identified by its git remote plus the path of the working
 * directory relative to the repository root. That keeps memories attached to a
 * repository when it is cloned elsewhere, and gives monorepo packages their own
 * scope. Directories without git fall back to a hash of their absolute path.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MemoryScope } from '../types.ts'

/** Resolved project identity used for `project.json` and the scope key. */
export interface ProjectIdentity {
  key: string
  label: string
  root: string
  remote?: string
}

const identityCache = new Map<string, ProjectIdentity>()

function sha12(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}

/** Canonical absolute path; symlinks resolved when the path exists. */
export function canonicalPath(input: string): string {
  const absolute = resolve(input)
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
}

/** Normalize a path for hashing: forward slashes, drive letter case folded. */
export function normalizePathForHash(input: string): string {
  let out = canonicalPath(input).replaceAll('\\', '/')
  if (process.platform === 'win32') {
    out = out.replace(/^([a-z]):/i, (_m, drive: string) => `${drive.toUpperCase()}:`)
  }
  out = out.replace(/\/+$/, '')
  return out.length === 0 ? '/' : out
}

/** Convert a git URL into `host/owner/repo`, dropping scheme, credentials and `.git`. */
export function normalizeRemote(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^git\+/, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
      return `${url.hostname.toLowerCase()}/${path}`
    } catch {
      // Fall through to the scp-like parser.
    }
  }
  // scp-like form: git@github.com:acme/repo.git (never a Windows drive path).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
  if (scp !== null && !/^[a-zA-Z]:[\\/]/.test(value)) {
    const host = scp[1]!.toLowerCase()
    const path = scp[2]!.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    return `${host}/${path}`
  }
  return value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

interface GitLocation {
  /** Directory containing the `.git` entry (the worktree root). */
  root: string
  gitdir: string
  commonDir: string
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Walk upward from `cwd` looking for `.git` (directory or worktree file). */
export function findGitRoot(cwd: string): GitLocation | null {
  let current = cwd
  for (;;) {
    const candidate = join(current, '.git')
    try {
      const stat = lstatSync(candidate)
      if (stat.isDirectory()) {
        return { root: current, gitdir: candidate, commonDir: candidate }
      }
      if (stat.isFile()) {
        const content = readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')
        const match = /^gitdir:\s*(.+)$/m.exec(content)
        if (match !== null) {
          const gitdir = isAbsolute(match[1]!.trim())
            ? resolve(match[1]!.trim())
            : resolve(current, match[1]!.trim())
          let commonDir = gitdir
          try {
            const commondirFile = join(gitdir, 'commondir')
            if (isFile(commondirFile)) {
              const value = readFileSync(commondirFile, 'utf8').trim()
              commonDir = isAbsolute(value) ? resolve(value) : resolve(gitdir, value)
            }
          } catch {
            commonDir = gitdir
          }
          return { root: current, gitdir, commonDir }
        }
      }
    } catch {
      // No `.git` here; keep walking.
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Pick the origin remote, else the first remote, from a git config file. */
export function readGitRemote(location: GitLocation): string | undefined {
  const candidates = [join(location.commonDir, 'config'), join(location.gitdir, 'config')]
  for (const file of candidates) {
    if (!isFile(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const remotes = new Map<string, string>()
    let section = ''
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line)
      if (header !== null) {
        section = header[1]!
        continue
      }
      if (/^\s*\[/.test(line)) {
        section = ''
        continue
      }
      if (section.length === 0) continue
      const entry = /^\s*url\s*=\s*(.+)$/.exec(line)
      if (entry !== null && !remotes.has(section)) {
        remotes.set(section, entry[1]!.trim())
      }
    }
    const chosen = remotes.get('origin') ?? remotes.values().next().value
    if (chosen !== undefined) return chosen
  }
  return undefined
}

/** Resolve the identity of a working directory. */
export function projectIdentity(cwd: string, mode: 'git' | 'path' = 'git'): ProjectIdentity {
  const real = canonicalPath(cwd)
  const cacheKey = `${mode}\0${real}`
  const cached = identityCache.get(cacheKey)
  if (cached !== undefined) return cached

  const pathIdentity = (): ProjectIdentity => ({
    key: `path-${sha12(normalizePathForHash(real))}`,
    label: basename(real) || real,
    root: real
  })

  if (mode === 'path') {
    const identity = pathIdentity()
    identityCache.set(cacheKey, identity)
    return identity
  }

  const git = findGitRoot(real)
  if (git !== null) {
    const rawRemote = readGitRemote(git)
    if (rawRemote !== undefined) {
      const remote = normalizeRemote(rawRemote)
      if (remote.length > 0) {
        let rel = relative(git.root, real).replaceAll(sep, '/')
        if (rel.length === 0) rel = '.'
        else if (rel.startsWith('../')) rel = '.'
        const identity: ProjectIdentity = {
          key: `repo-${sha12(`${remote}\0${rel}`)}`,
          label: basename(git.root) || remote,
          root: git.root,
          remote
        }
        identityCache.set(cacheKey, identity)
        return identity
      }
    }
  }

  const identity = pathIdentity()
  identityCache.set(cacheKey, identity)
  return identity
}

/** Project scope for a working directory. */
export function projectScopeFor(cwd: string, mode: 'git' | 'path' = 'git'): MemoryScope {
  return { type: 'project', key: projectIdentity(cwd, mode).key }
}

/** Stable scope key: `user` or `project:<key>`. */
export function scopeKey(scope: MemoryScope): string {
  return scope.type === 'user' ? 'user' : `project:${scope.key}`
}

/** Parse a serialized scope key. */
export function parseScopeKey(value: string): MemoryScope {
  if (value === 'user') return { type: 'user' }
  if (value.startsWith('project:')) {
    const key = value.slice('project:'.length)
    if (key.length === 0) throw new Error('invalid scope key')
    return { type: 'project', key }
  }
  throw new Error(`invalid scope key: ${value}`)
}

/** Root directory for a scope. */
export function scopeDir(root: string, scope: MemoryScope): string {
  return scope.type === 'user' ? join(root, 'user') : join(root, 'projects', scope.key)
}

/** Directory holding one memory per Markdown file. */
export function memoriesDir(root: string, scope: MemoryScope): string {
  return join(scopeDir(root, scope), 'memories')
}

/** Audit log path. */
export function auditFile(root: string): string {
  return join(root, 'audit.jsonl')
}

/** Temporary directory for atomic writes and cleanups. */
export function tmpDir(root: string): string {
  return join(root, 'tmp')
}

/** Directory used for pre-migration backups. */
export function backupDir(root: string): string {
  return join(root, 'memory.bak')
}

/** Project metadata file. */
export function projectJsonFile(root: string, key: string): string {
  return join(root, 'projects', key, 'project.json')
}

/** List project keys present on disk. */
export function listProjectKeys(root: string): string[] {
  const dir = join(root, 'projects')
  if (!isDirectory(dir)) return []
  try {
    return readdirSync(dir).filter((entry) => isDirectory(join(dir, entry)))
  } catch {
    return []
  }
}

/** Whether a file exists and is a regular file (symlinks rejected). */
export function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a path is a directory (symlinks rejected). */
export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Ensure a resolved path stays under the memory root. */
export function assertInside(root: string, candidate: string): string {
  const rootResolved = resolve(root)
  const target = resolve(candidate)
  const rel = relative(rootResolved, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the memory root')
  }
  return target
}

/** Convenience: project metadata path for a cwd. */
export function projectJsonForCwd(root: string, cwd: string, mode: 'git' | 'path'): string {
  return projectJsonFile(root, projectIdentity(cwd, mode).key)
}

/** Whether a path exists (used for optional project metadata). */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
