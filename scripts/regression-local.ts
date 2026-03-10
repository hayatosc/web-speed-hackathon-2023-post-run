import { writeFile } from 'node:fs/promises';
import { relative as relativePath } from 'node:path';
import process from 'node:process';

import type { Browser, Page } from 'puppeteer';

import {
  launchBrowser,
  type ManagedServerProcess,
  prepareArtifactDirectory,
  resetDatabase,
  resolvePort,
  runPackageScript,
  shouldManageServer,
  startServer,
  stopServer,
  waitForServer,
  withIsolatedPage,
} from './lib/local-app';
import {
  clickByXPath,
  countReviews,
  SEEDED_USER,
  signIn,
  signUp,
  submitOrder,
  waitForPathname,
  waitForReviewCount,
  waitForText,
} from './lib/shop-actions';

const DEFAULT_PORT = 4173;
const TARGET_URL = new URL(process.env.REGRESSION_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`);
const BASE_URL = TARGET_URL.origin;
const PORT = resolvePort(TARGET_URL, process.env.REGRESSION_PORT, DEFAULT_PORT);
const PRODUCT_PATH = process.env.REGRESSION_PRODUCT_PATH ?? '/product/1';
const ARTIFACT_DIRECTORY_INPUT = process.env.REGRESSION_ARTIFACT_DIR ?? '.artifacts/regression-local';
const SHOULD_MANAGE_SERVER = shouldManageServer(TARGET_URL);

type ScenarioStatus = 'FAIL' | 'PASS';

type ScenarioDefinition = {
  artifactKey: string;
  initialPath: string;
  name: string;
  run: (page: Page) => Promise<void>;
};

type ScenarioResult = {
  artifactPaths: string[];
  durationMs: number;
  errorMessage?: string;
  name: string;
  status: ScenarioStatus;
};

async function main(): Promise<number> {
  const artifactDirectory = await prepareArtifactDirectory(ARTIFACT_DIRECTORY_INPUT);
  let serverProcess: ManagedServerProcess | undefined;

  try {
    if (SHOULD_MANAGE_SERVER) {
      logProgress('build start');
      await runPackageScript('build');
      logProgress('build done');
      logProgress(`server start (${BASE_URL})`);
      serverProcess = startServer(PORT);
      await waitForServer(BASE_URL, serverProcess);
      logProgress('server ready');
    } else {
      logProgress(`use existing target (${BASE_URL})`);
    }

    const browser = await launchBrowser();

    try {
      const results = await runScenarios(browser, artifactDirectory);
      printSummary(results, artifactDirectory);
      return results.some((result) => result.status === 'FAIL') ? 1 : 0;
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer(serverProcess);
  }
}

async function runScenarios(browser: Browser, artifactDirectory: string): Promise<ScenarioResult[]> {
  const definitions: ScenarioDefinition[] = [
    {
      artifactKey: 'sign-in',
      initialPath: '/',
      name: 'ログインする',
      async run(page) {
        await signIn(page, SEEDED_USER);
        await page.waitForSelector('[data-testid="navigate-order"]', { visible: true });
      },
    },
    {
      artifactKey: 'review',
      initialPath: PRODUCT_PATH,
      name: 'レビューを書く',
      async run(page) {
        const comment = `ローカル回帰テスト ${Date.now().toString(36)}`;
        await signIn(page, SEEDED_USER);
        await page.waitForSelector('[data-testid="form-review"] #comment');

        const reviewCount = await countReviews(page);
        await page.type('#comment', comment);
        await clickByXPath(page, "//form[@data-testid='form-review']//button[normalize-space()='送信']");
        await waitForReviewCount(page, reviewCount + 1);
        await waitForText(page, comment);
      },
    },
    {
      artifactKey: 'order',
      initialPath: '/',
      name: '注文する',
      async run(page) {
        await signIn(page, SEEDED_USER);
        await page.goto(`${BASE_URL}/order`, { waitUntil: 'domcontentloaded' });
        await submitOrder(page);
        await waitForText(page, '購入が完了しました');
      },
    },
    {
      artifactKey: 'first-purchase',
      initialPath: PRODUCT_PATH,
      name: '初めてのユーザーが商品を買うまで',
      async run(page) {
        await signUp(page, {
          emailPrefix: 'local-regression',
          name: 'Local Regression',
          passwordPrefix: 'Local!Regression',
        });
        await clickByXPath(page, "//button[normalize-space()='カートに追加']");
        await waitForText(page, 'カートに追加済み');
        await clickByXPath(page, "//a[normalize-space()='購入手続きへ']");
        await waitForPathname(page, '/order');
        await submitOrder(page);
      },
    },
  ];

  const results: ScenarioResult[] = [];

  for (const definition of definitions) {
    await resetDatabase(BASE_URL);
    logProgress(`scenario start: ${definition.name}`);
    const result = await runScenario(browser, definition, artifactDirectory);
    results.push(result);
    logProgress(`scenario ${result.status.toLowerCase()}: ${definition.name}`);
  }

  return results;
}

async function runScenario(
  browser: Browser,
  definition: ScenarioDefinition,
  artifactDirectory: string,
): Promise<ScenarioResult> {
  const startedAt = Date.now();

  return withIsolatedPage(browser, async (page) => {
    try {
      await page.goto(`${BASE_URL}${definition.initialPath}`, { waitUntil: 'domcontentloaded' });
      await definition.run(page);

      return {
        artifactPaths: [],
        durationMs: Date.now() - startedAt,
        name: definition.name,
        status: 'PASS',
      };
    } catch (error: unknown) {
      const errorMessage = formatError(error);
      const artifactPaths = await writeFailureArtifacts(page, artifactDirectory, definition, errorMessage);

      return {
        artifactPaths,
        durationMs: Date.now() - startedAt,
        errorMessage,
        name: definition.name,
        status: 'FAIL',
      };
    }
  });
}

async function writeFailureArtifacts(
  page: Page,
  artifactDirectory: string,
  definition: ScenarioDefinition,
  errorMessage: string,
): Promise<string[]> {
  const screenshotPath = `${artifactDirectory}/${definition.artifactKey}.png`;
  const logPath = `${artifactDirectory}/${definition.artifactKey}.txt`;
  const artifactPaths = [toRelativeArtifactPath(logPath)];
  const logLines = [
    `Scenario: ${definition.name}`,
    `URL: ${page.url()}`,
    '',
    errorMessage,
  ];

  try {
    await page.screenshot({
      fullPage: true,
      path: screenshotPath,
    });
    artifactPaths.push(toRelativeArtifactPath(screenshotPath));
  } catch (error: unknown) {
    logLines.push('');
    logLines.push(`ScreenshotError: ${formatError(error)}`);
  }

  await writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8');

  return artifactPaths;
}

function printSummary(results: ScenarioResult[], artifactDirectory: string): void {
  const passedCount = results.filter((result) => result.status === 'PASS').length;
  const failedResults = results.filter((result) => result.status === 'FAIL');

  console.log('');
  console.log('=== Local Regression ===');
  console.log('');
  console.log('[Scenario]');
  for (const result of results) {
    console.log(`${result.status} ${result.name} (${formatDuration(result.durationMs)})`);
    if (result.errorMessage !== undefined) {
      console.log(result.errorMessage.split('\n')[0]);
      console.log(`Artifacts: ${result.artifactPaths.join(', ')}`);
    }
  }

  console.log('');
  console.log(`[Total] Passed ${passedCount} / Failed ${failedResults.length} / Total ${results.length}`);
  console.log(`[Artifacts] ${toRelativeArtifactPath(artifactDirectory)}`);
  console.log('');
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function toRelativeArtifactPath(path: string): string {
  const relativeArtifactPath = relativePath(process.cwd(), path);
  return relativeArtifactPath === '' ? '.' : relativeArtifactPath;
}

function logProgress(message: string): void {
  console.log(`[regression-local] ${message}`);
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
