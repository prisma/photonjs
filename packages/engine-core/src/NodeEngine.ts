import {
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
  RequestError,
  PrismaClientInitializationError,
  PrismaClientRustPanicError,
  getMessage,
} from './Engine'
import debugLib from 'debug'
import { getPlatform, Platform, mayBeCompatible } from '@prisma/get-platform'
import path from 'path'
import net from 'net'
import fs from 'fs'
import chalk from 'chalk'
import { GeneratorConfig } from '@prisma/generator-helper'
import { printGeneratorConfig } from './printGeneratorConfig'
import { fixPlatforms, plusX } from './util'
import { promisify } from 'util'
import EventEmitter from 'events'
import { convertLog, RustLog, RustError } from './log'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import byline from './byline'
import { Client } from './client'
import h2url from 'h2url'

const debug = debugLib('engine')
const exists = promisify(fs.exists)

export interface DatasourceOverwrite {
  name: string
  url: string
}

export interface EngineConfig {
  cwd?: string
  datamodelPath: string
  debug?: boolean
  prismaPath?: string
  fetcher?: (query: string) => Promise<{ data?: any; error?: any }>
  generator?: GeneratorConfig
  datasources?: DatasourceOverwrite[]
  showColors?: boolean
  logQueries?: boolean
  logLevel?: 'info' | 'warn'
  env?: Record<string, string>
}

/**
 * Node.js based wrapper to run the Prisma binary
 */

const knownPlatforms: Platform[] = [
  'native',
  'darwin',
  'debian-openssl-1.0.x',
  'debian-openssl-1.1.x',
  'rhel-openssl-1.0.x',
  'rhel-openssl-1.1.x',
  'windows',
]

export type Deferred = {
  resolve: () => void
  reject: (err: Error) => void
}

export class NodeEngine {
  private logEmitter: EventEmitter
  private showColors: boolean
  private logQueries: boolean
  private logLevel?: 'info' | 'warn'
  private env?: Record<string, string>
  private client?: Client
  port?: number
  debug: boolean
  child?: ChildProcessWithoutNullStreams
  /**
   * exiting is used to tell the .on('exit') hook, if the exit came from our script.
   * As soon as the Prisma binary returns a correct return code (like 1 or 0), we don't need this anymore
   */
  exiting: boolean = false
  managementApiEnabled: boolean = false
  datamodelJson?: string
  cwd: string
  datamodelPath: string
  prismaPath?: string
  url: string
  ready: boolean = false
  stderrLogs: string = ''
  stdoutLogs: string = ''
  currentRequestPromise?: any
  cwdPromise: Promise<string>
  platformPromise: Promise<Platform>
  platform?: Platform | string
  generator?: GeneratorConfig
  incorrectlyPinnedPlatform?: string
  datasources?: DatasourceOverwrite[]
  lastErrorLog?: RustLog
  lastError?: RustError
  startPromise?: Promise<any>
  engineStartDeferred?: Deferred
  constructor({
    cwd,
    datamodelPath,
    prismaPath,
    generator,
    datasources,
    showColors,
    logLevel,
    logQueries,
    env,
    ...args
  }: EngineConfig) {
    this.env = env
    this.cwd = this.resolveCwd(cwd)
    this.debug = args.debug || false
    this.datamodelPath = datamodelPath
    this.prismaPath = process.env.PRISMA_QUERY_ENGINE_BINARY || prismaPath
    this.generator = generator
    this.datasources = datasources
    this.logEmitter = new EventEmitter()
    this.showColors = showColors || false
    this.logLevel = logLevel
    this.logQueries = logQueries || false

    this.logEmitter.on('error', (log: RustLog) => {
      if (this.debug) {
        debugLib('engine:log')(log)
      }
      this.lastErrorLog = log
      if (log.fields.message === 'PANIC') {
        this.handlePanic(log)
      }
    })

    if (this.platform) {
      if (!knownPlatforms.includes(this.platform as Platform) && !fs.existsSync(this.platform)) {
        throw new PrismaClientInitializationError(
          `Unknown ${chalk.red('PRISMA_QUERY_ENGINE_BINARY')} ${chalk.redBright.bold(
            this.platform,
          )}. Possible binaryTargets: ${chalk.greenBright(
            knownPlatforms.join(', '),
          )} or a path to the query engine binary.
You may have to run ${chalk.greenBright('prisma2 generate')} for your changes to take effect.`,
        )
      }
    } else {
      this.getPlatform()
    }
    if (this.debug) {
      debugLib.enable('*')
    }
  }

  private resolveCwd(cwd?: string): string {
    if (cwd && fs.existsSync(cwd) && fs.lstatSync(cwd).isDirectory()) {
      return cwd
    }

    return process.cwd()
  }

  on(event: 'query' | 'info' | 'warn', listener: (log: RustLog) => any) {
    this.logEmitter.on(event, listener)
  }

  async getPlatform() {
    if (this.platformPromise) {
      return this.platformPromise
    }

    this.platformPromise = getPlatform()

    return this.platformPromise
  }

  private getQueryEnginePath(platform: string, prefix: string = __dirname): string {
    let queryEnginePath = path.join(prefix, `query-engine-${platform}`)

    if (platform === 'windows') {
      queryEnginePath = `${queryEnginePath}.exe`
    }

    return queryEnginePath
  }

  private handlePanic(log: RustLog) {
    this.child.kill()
    if (this.currentRequestPromise) {
      ;(this.currentRequestPromise as any).cancel()
    }
  }

  private async resolvePrismaPath() {
    if (this.prismaPath) {
      return this.prismaPath
    }

    const platform = await this.getPlatform()
    if (this.platform && this.platform !== platform) {
      this.incorrectlyPinnedPlatform = this.platform
    }

    this.platform = this.platform || platform

    const fileName = eval(`require('path').basename(__filename)`)
    if (fileName === 'NodeEngine.js') {
      return this.getQueryEnginePath(this.platform, path.resolve(__dirname, `..`))
    } else {
      return this.getQueryEnginePath(this.platform)
    }
  }

  // If we couldn't find the correct binary path, let's look for an alternative
  // This is interesting for libssl 1.0.1 vs libssl 1.0.2 cases

  private async resolveAlternativeBinaryPath(platform: Platform): Promise<string | null> {
    const compatiblePlatforms = knownPlatforms.slice(1).filter(p => mayBeCompatible(p, platform))
    const binariesExist = await Promise.all(
      compatiblePlatforms.map(async platform => {
        const filePath = this.getQueryEnginePath(platform)
        return {
          exists: await exists(filePath),
          platform,
          filePath,
        }
      }),
    )

    const firstExistingPlatform = binariesExist.find(b => b.exists)
    if (firstExistingPlatform) {
      return firstExistingPlatform.filePath
    }

    return null
  }

  // get prisma path
  private async getPrismaPath() {
    const prismaPath = await this.resolvePrismaPath()
    const platform = await this.getPlatform()
    if (!(await exists(prismaPath))) {
      let info = '.'
      if (this.generator) {
        const fixedGenerator = {
          ...this.generator,
          binaryTargets: fixPlatforms(this.generator.binaryTargets as Platform[], this.platform!),
        }
        info = `:\n${chalk.greenBright(printGeneratorConfig(fixedGenerator))}`
      }

      const pinnedStr = this.incorrectlyPinnedPlatform
        ? `\nYou incorrectly pinned it to ${chalk.redBright.bold(`${this.incorrectlyPinnedPlatform}`)}\n`
        : ''

      throw new PrismaClientInitializationError(
        `Query engine binary for current platform ${chalk.bold.greenBright(platform)} could not be found.${pinnedStr}
Prisma Client looked in ${chalk.underline(prismaPath)} but couldn't find it.
Make sure to adjust the generator configuration in the ${chalk.bold('schema.prisma')} file${info}
Please run ${chalk.greenBright('prisma2 generate')} for your changes to take effect.
${chalk.gray(
  `Note, that by providing \`native\`, Prisma Client automatically resolves \`${platform}\`.
Read more about deploying Prisma Client: ${chalk.underline(
    'https://github.com/prisma/prisma2/blob/master/docs/core/generators/prisma-client-js.md',
  )}`,
)}`,
      )
    }

    if (this.incorrectlyPinnedPlatform) {
      console.log(`${chalk.yellow('Warning:')} You pinned the platform ${chalk.bold(
        this.incorrectlyPinnedPlatform,
      )}, but Prisma Client detects ${chalk.bold(await this.getPlatform())}.
This means you should very likely pin the platform ${chalk.greenBright(await this.getPlatform())} instead.
${chalk.dim("In case we're mistaken, please report this to us 🙏.")}`)
    }

    plusX(prismaPath)

    return prismaPath
  }

  printDatasources(): string {
    if (this.datasources) {
      return JSON.stringify(this.datasources)
    }

    return '[]'
  }

  /**
   * Starts the engine, returns the url that it runs on
   */
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.internalStart()
    }
    return this.startPromise
  }

  private internalStart(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        this.port = await this.getFreePort()

        const env: any = {
          PRISMA_DML_PATH: this.datamodelPath,
          PORT: String(this.port),
          RUST_BACKTRACE: '1',
          RUST_LOG: 'info',
        }

        if (this.logQueries || this.logLevel === 'info') {
          env.RUST_LOG = 'info'
          if (this.logQueries) {
            env.LOG_QUERIES = 'true'
          }
        }

        if (this.logLevel === 'warn') {
          env.RUST_LOG = 'warn'
        }

        if (this.datasources) {
          env.OVERWRITE_DATASOURCES = this.printDatasources()
        }

        if (!process.env.NO_COLOR && this.showColors) {
          env.CLICOLOR_FORCE = '1'
        }

        debug(env)
        debug({ cwd: this.cwd })

        const prismaPath = await this.getPrismaPath()

        this.child = spawn(prismaPath, ['--enable_raw_queries'], {
          env: {
            ...this.env, // user-provided env vars
            ...process.env,
            ...env,
          },
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        byline(this.child.stderr).on('data', msg => {
          const data = String(msg)
          debug('stderr', data)
          try {
            const json = JSON.parse(data)
            if (typeof json.is_panic !== 'undefined') {
              debug(json)
              this.lastError = json
              if (this.engineStartDeferred) {
                this.engineStartDeferred.reject(new PrismaClientInitializationError(this.lastError.message))
              }
            }
          } catch (e) {
            if (!data.includes('Printing to stderr') && !data.includes('Listening on ')) {
              this.stderrLogs += '\n' + data
            }
          }
        })

        byline(this.child.stdout).on('data', msg => {
          const data = String(msg)
          try {
            const json = JSON.parse(data)
            debug('stdout', json)
            if (
              this.engineStartDeferred &&
              json.level === 'INFO' &&
              json.target === 'prisma::server' &&
              json.fields?.message.startsWith('Started http server')
            ) {
              this.engineStartDeferred.resolve()
              this.engineStartDeferred = undefined
            }
            if (typeof json.is_panic === 'undefined') {
              const log = convertLog(json)
              this.logEmitter.emit(log.level, log)
            } else {
              this.lastError = json
            }
          } catch (e) {
            // debug(e, data)
          }
        })

        this.child.on('exit', (code, signal) => {
          if (!this.child) {
            return
          }
          if (this.lastError) {
            return
          }
          if (this.lastErrorLog) {
            this.lastErrorLog.target = 'exit'
            return
          }
          if (code === 126) {
            this.lastErrorLog = {
              timestamp: new Date(),
              target: 'exit',
              level: 'error',
              fields: {
                message: `Couldn't start query engine as it's not executable on this operating system.
You very likely have the wrong "binaryTarget" defined in the schema.prisma file.`,
              },
            }
          } else {
            this.lastErrorLog = {
              target: 'exit',
              timestamp: new Date(),
              level: 'error',
              fields: {
                message: (this.stderrLogs || '') + (this.stdoutLogs || '') + code,
              },
            }
          }
        })

        this.child.on('error', err => {
          this.lastError = {
            message: err.message,
            backtrace: 'Could not start query engine',
            is_panic: false,
          }
          reject(err)
        })

        this.child.on('close', (code, signal) => {
          if (code === null && signal === 'SIGABRT' && this.child) {
            console.error(`${chalk.bold.red(`Error in Prisma Client:`)}${this.stderrLogs}

This is a non-recoverable error which probably happens when the Prisma Query Engine has a stack overflow.
Please create an issue in https://github.com/prisma/prisma-client-js describing the last Prisma Client query you called.`)
          }
        })

        if (this.lastError) {
          return reject(new PrismaClientInitializationError(getMessage(this.lastError)))
        }

        if (this.lastErrorLog) {
          return reject(new PrismaClientInitializationError(getMessage(this.lastErrorLog)))
        }

        try {
          await new Promise((resolve, reject) => {
            this.engineStartDeferred = { resolve, reject }
          })
        } catch (err) {
          await this.child.kill()
          throw err
        }

        const url = `http://localhost:${this.port}`
        this.url = url
        // TODO: Re-enable
        // this.client = new Client(url)
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  }

  fail = async (e, why) => {
    debug(e, why)
    await this.stop()
  }

  /**
   * If Prisma runs, stop it
   */
  async stop() {
    await this.start()
    if (this.currentRequestPromise) {
      try {
        await this.currentRequestPromise
      } catch (e) {
        //
      }
    }
    if (this.child) {
      debug(`Stopping Prisma engine`)
      this.exiting = true
      // this.client.close()
      await this.child.kill()
      delete this.child
    }
  }

  /**
   * Use the port 0 trick to get a new port
   */
  protected getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(s => s.end(''))
      server.unref()
      server.on('error', reject)
      server.listen(0, () => {
        const address = server.address()
        const port = typeof address === 'string' ? parseInt(address.split(':').slice(-1)[0], 10) : address.port
        server.close(e => {
          if (e) {
            reject(e)
          }
          resolve(port)
        })
      })
    })
  }

  /**
   * Make sure that our internal port is not conflicting with the prisma.yml's port
   * @param str config
   */
  protected trimPort(str: string) {
    return str
      .split('\n')
      .filter(l => !l.startsWith('port:'))
      .join('\n')
  }

  async request<T>(queries: string[]): Promise<T> {
    await this.start()

    if (!this.child) {
      throw new PrismaClientUnknownRequestError(`Can't perform request, as the Engine has already been stopped`)
    }

    const variables = {}
    const body = {
      batch: queries.map(query => ({ query, variables })),
    }

    // this.currentRequestPromise = this.client.request(body)
    this.currentRequestPromise = h2url.concat({
      url: this.url,
      body: JSON.stringify(body),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    })

    return this.currentRequestPromise
      .then(data => {
        const body = JSON.parse(data.body)

        return body.map(result => {
          if (result.errors) {
            return this.graphQLToJSError(result.errors[0])
          }
          return result
        })
      })
      .catch(error => {
        debug({ error })
        if (this.currentRequestPromise.isCanceled && this.lastError) {
          // TODO: Replace these errors with known or unknown request errors
          if (this.lastError.is_panic) {
            throw new PrismaClientRustPanicError(getMessage(this.lastError))
          } else {
            throw new PrismaClientUnknownRequestError(getMessage(this.lastError))
          }
        }
        if (this.currentRequestPromise.isCanceled && this.lastErrorLog) {
          throw new PrismaClientUnknownRequestError(getMessage(this.lastErrorLog))
        }
        if ((error.code && error.code === 'ECONNRESET') || error.code === 'ECONNREFUSED') {
          if (this.lastError) {
            throw new PrismaClientUnknownRequestError(getMessage(this.lastError))
          }
          if (this.lastErrorLog) {
            throw new PrismaClientUnknownRequestError(getMessage(this.lastErrorLog))
          }
          const logs = this.stderrLogs || this.stdoutLogs
          throw new PrismaClientUnknownRequestError(logs)
        }

        throw error
      })
  }

  private graphQLToJSError(error: RequestError): PrismaClientKnownRequestError | PrismaClientUnknownRequestError {
    if (error.user_facing_error.error_code) {
      return new PrismaClientKnownRequestError(
        error.user_facing_error.message,
        error.user_facing_error.error_code,
        error.user_facing_error.meta,
      )
    }

    return new PrismaClientUnknownRequestError(error.user_facing_error.message)
  }
}
