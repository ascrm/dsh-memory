/**
 * 项目身份与文件系统布局。
 *
 * 项目由 git remote 加上工作目录相对仓库根目录的路径来标识。这样仓库被克隆到别处时，
 * 记忆仍会附着在同一个仓库上，monorepo 中的各包也能拥有自己的作用域。没有 git 的目录
 * 退化为对其绝对路径取哈希。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MemoryScope } from '../types.ts'

/** 解析后的项目身份，用于 `project.json` 和 scope key。 */
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

/** 规范化的绝对路径；路径存在时会解析符号链接。 */
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

/** 规范化用于哈希的路径：使用正斜杠，盘符字母统一为大写。 */
export function normalizePathForHash(input: string): string {
  let out = canonicalPath(input).replaceAll('\\', '/')
  if (process.platform === 'win32') {
    out = out.replace(/^([a-z]):/i, (_m, drive: string) => `${drive.toUpperCase()}:`)
  }
  out = out.replace(/\/+$/, '')
  return out.length === 0 ? '/' : out
}

/** 把 git URL 转换为 `host/owner/repo`，去掉 scheme、凭据和 `.git`。 */
export function normalizeRemote(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^git\+/, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
      return `${url.hostname.toLowerCase()}/${path}`
    } catch {
      // 交给下面的 scp 风格解析器处理。
    }
  }
  // scp 风格形式：git@github.com:acme/repo.git（绝不是 Windows 盘符路径）。
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
  /** 包含 `.git` 条目的目录（即 worktree 根目录）。 */
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

/** 从 `cwd` 逐级向上查找 `.git`（目录或 worktree 文件）。 */
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
      // 这里没有 `.git`，继续向上查找。
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 从 git config 文件中取出 origin remote，没有则取第一个 remote。 */
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

/** 解析某个工作目录的身份。 */
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

/** 某个工作目录对应的项目作用域。 */
export function projectScopeFor(cwd: string, mode: 'git' | 'path' = 'git'): MemoryScope {
  return { type: 'project', key: projectIdentity(cwd, mode).key }
}

/** 稳定的 scope key：`user` 或 `project:<key>`。 */
export function scopeKey(scope: MemoryScope): string {
  return scope.type === 'user' ? 'user' : `project:${scope.key}`
}

/** 解析序列化后的 scope key。 */
export function parseScopeKey(value: string): MemoryScope {
  if (value === 'user') return { type: 'user' }
  if (value.startsWith('project:')) {
    const key = value.slice('project:'.length)
    if (key.length === 0) throw new Error('invalid scope key')
    return { type: 'project', key }
  }
  throw new Error(`invalid scope key: ${value}`)
}

/** 某个作用域的根目录。 */
export function scopeDir(root: string, scope: MemoryScope): string {
  return scope.type === 'user' ? join(root, 'user') : join(root, 'projects', scope.key)
}

/** 每个 Markdown 文件存放一条记忆的目录。 */
export function memoriesDir(root: string, scope: MemoryScope): string {
  return join(scopeDir(root, scope), 'memories')
}

/** 审计日志路径。 */
export function auditFile(root: string): string {
  return join(root, 'audit.jsonl')
}

/** 用于原子写入和清理的临时目录。 */
export function tmpDir(root: string): string {
  return join(root, 'tmp')
}

/** 用于迁移前备份的目录。 */
export function backupDir(root: string): string {
  return join(root, 'memory.bak')
}

/** 项目元数据文件。 */
export function projectJsonFile(root: string, key: string): string {
  return join(root, 'projects', key, 'project.json')
}

/** 列出磁盘上存在的项目键。 */
export function listProjectKeys(root: string): string[] {
  const dir = join(root, 'projects')
  if (!isDirectory(dir)) return []
  try {
    return readdirSync(dir).filter((entry) => isDirectory(join(dir, entry)))
  } catch {
    return []
  }
}

/** 路径是否存在且为普通文件（拒绝符号链接）。 */
export function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** 路径是否为目录（拒绝符号链接）。 */
export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 确保解析后的路径仍位于记忆根目录之下。 */
export function assertInside(root: string, candidate: string): string {
  const rootResolved = resolve(root)
  const target = resolve(candidate)
  const rel = relative(rootResolved, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the memory root')
  }
  return target
}

/** 便捷函数：某个 cwd 对应的项目元数据路径。 */
export function projectJsonForCwd(root: string, cwd: string, mode: 'git' | 'path'): string {
  return projectJsonFile(root, projectIdentity(cwd, mode).key)
}

/** 路径是否存在（用于可选的 project 元数据）。 */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
