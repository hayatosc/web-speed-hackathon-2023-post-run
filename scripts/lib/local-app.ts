import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type { Browser, Page } from 'puppeteer';

export type ManagedServerProcess = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

const puppeteerModulePromise = import('puppeteer');

export function shouldManageServer(targetUrl: URL): boolean {
  return targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost';
}

export function resolvePort(targetUrl: URL, portText: string | undefined, defaultPort: number): number {
  return Number((portText ?? targetUrl.port) || defaultPort);
}

export async function prepareArtifactDirectory(directoryPath: string): Promise<string> {
  const artifactDirectory = resolvePath(process.cwd(), directoryPath);
  await rm(artifactDirectory, { force: true, recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  return artifactDirectory;
}

export async function launchBrowser(): Promise<Browser> {
  const { default: puppeteer } = await puppeteerModulePromise;

  return puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: puppeteer.executablePath(),
    headless: true,
  });
}

export async function withIsolatedPage<T>(browser: Browser, callback: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(60_000);

  try {
    return await callback(page);
  } finally {
    await context.close();
  }
}

export async function runPackageScript(scriptName: string): Promise<void> {
  const [command, args] = getPackageScriptCommand(scriptName);
  await runCommand(command, args, {
    env: process.env,
  });
}

export function startServer(port: number, scriptName = 'start:server:once'): ManagedServerProcess {
  const [command, args] = getPackageScriptCommand(scriptName);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let output = '';
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });

  return {
    child,
    output: () => output,
  };
}

export async function stopServer(serverProcess: ManagedServerProcess | undefined): Promise<void> {
  if (serverProcess === undefined || serverProcess.child.exitCode != null) {
    return;
  }

  const pid = serverProcess.child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }

  await Promise.race([
    once(serverProcess.child, 'exit'),
    delay(10_000).then(async () => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error: unknown) {
        if (!isErrnoException(error) || error.code !== 'ESRCH') {
          throw error;
        }
      }
      await once(serverProcess.child, 'exit');
    }),
  ]);
}

export async function waitForServer(baseUrl: string, serverProcess: ManagedServerProcess): Promise<void> {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    if (serverProcess.child.exitCode != null) {
      throw new Error(`サーバー起動前に終了しました\n${serverProcess.output()}`);
    }

    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // noop
    }

    await delay(1_000);
  }

  throw new Error(`サーバーの起動を待機中にタイムアウトしました\n${serverProcess.output()}`);
}

export async function resetDatabase(baseUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/initialize`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`/initialize に失敗しました: ${response.status}`);
      }

      return;
    } catch (error: unknown) {
      if (attempt === 3) {
        throw error;
      }

      await delay(1_000);
    }
  }
}

async function runCommand(command: string, args: string[], options: SpawnOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} が終了コード ${code} で失敗しました`));
    });
  });
}

function getPackageScriptCommand(scriptName: string): [string, string[]] {
  const npmExecPath = process.env.npm_execpath;

  if (typeof npmExecPath === 'string' && npmExecPath !== '') {
    if (/\.(?:c|m)?js$/u.test(npmExecPath)) {
      return [process.execPath, [npmExecPath, 'run', scriptName]];
    }

    return [npmExecPath, ['run', scriptName]];
  }

  if (process.platform === 'win32') {
    return ['pnpm.cmd', ['run', scriptName]];
  }

  return ['pnpm', ['run', scriptName]];
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
