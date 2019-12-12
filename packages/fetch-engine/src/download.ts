import fs from 'fs'
import { promisify } from 'util'
import chalk from 'chalk'

// Packages
import path from 'path'
import Debug from 'debug'
import makeDir from 'make-dir'

// Utils
import { getBar, info, warn } from './log'
import plusxSync from './chmod'
import { copy } from './copy'
import { getPlatform, Platform } from '@prisma/get-platform'
import { downloadZip } from './downloadZip'
import { getCacheDir, getLocalLastModified, getRemoteLastModified, getDownloadUrl, BinaryKind } from './util'
import { cleanupCache } from './cleanupCache'

const debug = Debug('download')
const writeFile = promisify(fs.writeFile)
const exists = promisify(fs.exists)

const channel = 'master'
export interface BinaryDownloadConfiguration {
  'query-engine'?: string
  'migration-engine'?: string
  'introspection-engine'?: string
}

export interface DownloadOptions {
  binaries: BinaryDownloadConfiguration
  binaryTargets?: Platform[]
  showProgress?: boolean
  progressCb?: (progress: number) => any
  version?: string
  skipDownload?: boolean
  failSilent?: boolean
}

interface DownloadBinaryOptions {
  sourcePath: string
  targetPath: string
  version: string
  platform: string
  binaryName: BinaryKind
  progressCb?: (progress: number) => any
  failSilent?: boolean
}

export type BinaryPaths = {
  migrationEngine?: { [binaryTarget: string]: string } // key: target, value: path
  queryEngine?: { [binaryTarget: string]: string }
  introspectionEngine?: { [binaryTarget: string]: string }
}

const binaryToEnvVar = {
  'migration-engine': 'PRISMA_MIGRATION_ENGINE_BINARY',
  'query-engine': 'PRISMA_QUERY_ENGINE_BINARY',
  'introspection-engine': 'PRISMA_INTROSPECTION_ENGINE_BINARY',
}

export async function download(options: DownloadOptions): Promise<BinaryPaths> {
  if (
    options.binaries['introspection-engine'] &&
    options.binaries['migration-engine'] &&
    options.binaries['query-engine']
  ) {
    const downloadDoneFile = path.join(options.binaries['query-engine'], 'download-done')
    if (fs.existsSync(downloadDoneFile)) {
      debug(`Skipping download as ${downloadDoneFile} exists`)
      return
    }
  }

  await cleanupCache()
  const platform = await getPlatform()
  const mergedOptions: DownloadOptions = {
    binaryTargets: [platform],
    version: 'latest',
    ...options,
    binaries: mapKeys(options.binaries, key => engineTypeToBinaryType(key, platform)), // just necessary to support both camelCase and hyphen-case
  }
  const bar = options.showProgress
    ? getBar(`Downloading Prisma engines for ${mergedOptions.binaryTargets.map(p => chalk.bold(p)).join(' and ')}`)
    : undefined
  const progressMap: { [key: string]: number } = {}
  // Object.values is faster than Object.keys
  const numDownloads = Object.values(mergedOptions.binaries).length * Object.values(mergedOptions.binaryTargets).length
  const collectiveCallback =
    options.progressCb || options.showProgress
      ? (sourcePath: string) => progress => {
          progressMap[sourcePath] = progress
          const progressValues = Object.values(progressMap)
          const totalProgress =
            progressValues.reduce((acc, curr) => {
              return acc + curr
            }, 0) / numDownloads
          if (options.progressCb) {
            options.progressCb(totalProgress)
          }
          if (bar) {
            bar.update(totalProgress)
          }
        }
      : undefined

  const binaryPaths: BinaryPaths = Object.keys(options.binaries).reduce((acc, curr) => {
    acc[curr] = {}
    return acc
  }, {})

  await Promise.all(
    Object.entries(options.binaries).map(([binaryName, targetDir]) => {
      return Promise.all(
        mergedOptions.binaryTargets.map(async platform => {
          const sourcePath = getDownloadUrl(channel, mergedOptions.version, platform, binaryName as BinaryKind)
          const targetPath = path.resolve(targetDir, getBinaryName(binaryName, platform))

          const envVar = binaryToEnvVar[binaryName]
          if (envVar && process.env[envVar]) {
            if (!fs.existsSync(process.env[envVar])) {
              throw new Error(
                `Env var ${chalk.bold(envVar)} is provided but provided path ${chalk.underline(
                  process.env.PRISMA_QUERY_ENGINE_BINARY,
                )} can't be resolved.`,
              )
            }
            debug(
              `Using env var ${chalk.bold(envVar)} for binary ${chalk.bold(
                binaryName,
              )}, which points to ${chalk.underline(process.env[envVar])}`,
            )
            binaryPaths[binaryName][platform] = path.resolve(process.env[envVar])
          } else {
            debug(`Setting binary path for ${binaryName} ${platform} to ${targetPath}`)
            binaryPaths[binaryName][platform] = targetPath
          }

          if (!options.skipDownload) {
            await downloadBinary({
              sourcePath,
              binaryName: binaryName as BinaryKind,
              platform,
              version: mergedOptions.version,
              targetPath,
              progressCb: collectiveCallback ? collectiveCallback(sourcePath) : undefined,
              failSilent: options.failSilent,
            })
          }
        }),
      )
    }),
  )

  if (bar) {
    bar.update(1)
    bar.terminate()
  }

  if (
    options.binaries['introspection-engine'] &&
    options.binaries['migration-engine'] &&
    options.binaries['query-engine']
  ) {
    fs.writeFileSync(path.join(options.binaries['query-engine'], 'download-done'), 'done')
  }

  return binaryPaths
}

function getBinaryName(binaryName, platform) {
  const extension = platform === 'windows' ? '.exe' : ''
  if (binaryName === 'migration-engine') {
    // for the migration-engine we don't postfix it with the platform, as it's not necessary
    return 'migration-engine' + extension
  }
  return `${binaryName}-${platform}${extension}`
}

async function downloadBinary({
  sourcePath,
  targetPath,
  version,
  platform,
  progressCb,
  binaryName,
  failSilent,
}: DownloadBinaryOptions) {
  await makeDir(path.dirname(targetPath))
  debug(`Downloading ${sourcePath} to ${targetPath}`)
  try {
    fs.writeFileSync(
      targetPath,
      '#!/usr/bin/env node\n' + `console.log("Please wait until the \'prisma ${binaryName}\' download completes!")\n`,
    )
  } catch (err) {
    if (err.code === 'EACCES') {
      if (!failSilent) {
        warn('Please try installing Prisma 2 CLI again with the `--unsafe-perm` option.')
        info('Example: `npm i -g --unsafe-perm prisma2`')
        process.exit(1)
      } else {
        debug(`Download failed due to EACCES error, but that's fine`)
        process.exit(0)
      }
    }

    throw err
  }

  // Print an empty line
  const cacheDir = await getCacheDir(channel, version, platform)
  const cachedTargetPath = path.join(cacheDir, binaryName)
  const cachedLastModifiedPath = path.join(cacheDir, 'lastModified-' + binaryName)

  const [cachedPrismaExists, localLastModified, targetExists] = await Promise.all([
    exists(cachedTargetPath),
    getLocalLastModified(cachedLastModifiedPath),
    exists(targetPath),
  ])

  debug({ cachedPrismaExists, targetExists, cachedTargetPath, targetPath })

  if (cachedPrismaExists && localLastModified) {
    const remoteLastModified = await getRemoteLastModified(sourcePath)
    // If there is no new binary and we have it localy, copy it over
    if (localLastModified >= remoteLastModified) {
      debug(`Taking cache`)
      await copy(cachedTargetPath, targetPath)
      return
    }
  }

  if (progressCb) {
    progressCb(0)
  }

  debug(`Downloading zip`)
  const lastModified = await downloadZip(sourcePath, targetPath, progressCb)
  if (progressCb) {
    progressCb(1)
  }

  plusxSync(targetPath)

  try {
    await copy(targetPath, cachedTargetPath)
    await writeFile(cachedLastModifiedPath, lastModified)
  } catch (e) {
    debug({ sourcePath, targetPath }, e)
    // let this fail silently - the CI system may have reached the file size limit
  }
}

function engineTypeToBinaryType(engineType: string, platform: string): string {
  if (engineType === 'introspectionEngine') {
    return 'introspection-engine' as any // TODO: Remove as any as soon as type added to @prisma/fetch-engine
  }

  if (engineType === 'migrationEngine') {
    return 'migration-engine'
  }

  if (engineType === 'queryEngine') {
    return 'query-engine'
  }

  if (engineType === 'native') {
    return platform
  }

  return engineType
}

function mapKeys<T extends object>(obj: T, mapper: (key: keyof T) => string): any {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    acc[mapper(key as keyof T)] = value
    return acc
  }, {})
}
