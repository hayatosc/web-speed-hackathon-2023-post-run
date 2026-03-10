import process from 'node:process';

import type { Config } from 'lighthouse';
import type { Browser, Page } from 'puppeteer';

import {
  launchBrowser,
  type ManagedServerProcess,
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
  SEEDED_USER,
  clickByXPath,
  clearAndType,
  countReviews,
  signIn,
  signUp,
  submitOrder,
  waitForPathname,
  waitForReviewCount,
} from './lib/shop-actions';

const DEFAULT_PORT = 4173;
const TARGET_URL = new URL(process.env.SCORING_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`);
const BASE_URL = TARGET_URL.origin;
const PORT = resolvePort(TARGET_URL, process.env.SCORING_PORT, DEFAULT_PORT);
const PRODUCT_PATH = process.env.SCORING_PRODUCT_PATH ?? '/product/1';
const NOT_FOUND_PATH = process.env.SCORING_NOT_FOUND_PATH ?? '/__local-scoring-not-found__';
const SHOULD_MANAGE_SERVER = shouldManageServer(TARGET_URL);

const PAGE_CONFIG: Config = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
  },
};

const FLOW_CONFIG: Config = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: ['total-blocking-time', 'experimental-interaction-to-next-paint'],
    throttlingMethod: 'provided',
  },
};

type LighthouseNavigation = typeof import('lighthouse')['navigation'];
type LighthouseStartFlow = typeof import('lighthouse')['startFlow'];

type ScoreResult = {
  score: number;
};

type PageScoreResult = ScoreResult & {
  name: string;
};

type FlowScoreResult = ScoreResult & {
  inp: number;
  name: string;
  tbt: number;
};

type Summary = {
  flowResults: FlowScoreResult[];
  pageResults: PageScoreResult[];
};

type PageDefinition = {
  flags?: {
    disableStorageReset?: boolean;
  };
  name: string;
  path: string;
  setup?: (page: Page) => Promise<void>;
};

type FlowDefinition = {
  initialPath: string;
  name: string;
  perform: (page: Page) => Promise<void>;
};

const lighthouseModulePromise = import('lighthouse');

async function main(): Promise<void> {
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

    const { navigation, startFlow } = await lighthouseModulePromise;
    const browser = await launchBrowser();

    try {
      const pageResults = await measurePageLandingScores(browser, navigation);
      const flowResults = await measureUserFlowScores(browser, startFlow);

      printSummary({ pageResults, flowResults });
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer(serverProcess);
  }
}

async function measurePageLandingScores(browser: Browser, navigation: LighthouseNavigation): Promise<PageScoreResult[]> {
  const definitions: PageDefinition[] = [
    {
      name: 'ホーム',
      path: '/',
    },
    {
      name: '商品詳細',
      path: PRODUCT_PATH,
    },
    {
      name: '購入手続き',
      path: '/order',
      async setup(page) {
        await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await signIn(page, SEEDED_USER);
      },
      flags: {
        disableStorageReset: true,
      },
    },
    {
      name: '404',
      path: NOT_FOUND_PATH,
    },
  ];

  const results: PageScoreResult[] = [];

  for (const definition of definitions) {
    await resetDatabase(BASE_URL);
    logProgress(`page start: ${definition.name}`);
    const result = await withIsolatedPage(browser, async (page) => {
      if (definition.setup !== undefined) {
        await definition.setup(page);
      }

      const runnerResult = await navigation(page, `${BASE_URL}${definition.path}`, {
        config: PAGE_CONFIG,
        flags: definition.flags,
      });
      const lhr = runnerResult?.lhr;

      if (lhr === undefined) {
        throw new Error(`${definition.name} の Lighthouse 結果を取得できませんでした`);
      }

      const performanceCategory = lhr.categories['performance'];

      if (performanceCategory === undefined) {
        throw new Error(`${definition.name} の performance category を取得できませんでした`);
      }

      return {
        name: definition.name,
        score: normalizeScore(performanceCategory.score),
      };
    });

    results.push(result);
    logProgress(`page done: ${definition.name} (${formatScore(result.score)})`);
  }

  return results;
}

async function measureUserFlowScores(browser: Browser, startFlow: LighthouseStartFlow): Promise<FlowScoreResult[]> {
  const definitions: FlowDefinition[] = [
    {
      name: 'ログインする',
      initialPath: '/',
      async perform(page) {
        await signIn(page, SEEDED_USER);
      },
    },
    {
      name: 'レビューを書く',
      initialPath: PRODUCT_PATH,
      async perform(page) {
        await signIn(page, SEEDED_USER);
        await page.waitForSelector('[data-testid="form-review"] #comment');

        const reviewCount = await countReviews(page);
        await clearAndType(page, '#comment', 'ローカル採点用のレビューです。');
        await clickByXPath(page, "//form[@data-testid='form-review']//button[normalize-space()='送信']");
        await waitForReviewCount(page, reviewCount + 1);
      },
    },
    {
      name: '注文する',
      initialPath: '/',
      async perform(page) {
        await signIn(page, SEEDED_USER);
        await page.goto(`${BASE_URL}/order`, { waitUntil: 'networkidle0' });
        await submitOrder(page);
      },
    },
    {
      name: '初めてのユーザーが商品を買うまで',
      initialPath: PRODUCT_PATH,
      async perform(page) {
        await signUp(page, {
          emailPrefix: 'local-score',
          name: 'Local Scoring',
          passwordPrefix: 'Local!Score',
        });
        await clickByXPath(page, "//button[normalize-space()='カートに追加']");
        await page.waitForXPath("//*[contains(normalize-space(), 'カートに追加済み')]");
        await clickByXPath(page, "//a[normalize-space()='購入手続きへ']");
        await waitForPathname(page, '/order');
        await submitOrder(page);
      },
    },
  ];

  const results: FlowScoreResult[] = [];

  for (const definition of definitions) {
    await resetDatabase(BASE_URL);
    logProgress(`flow start: ${definition.name}`);
    const result = await withIsolatedPage(browser, async (page) => {
      const flow = await startFlow(page, {
        name: definition.name,
        config: FLOW_CONFIG,
        flags: {
          throttlingMethod: 'provided',
        },
      });

      await flow.navigate(`${BASE_URL}${definition.initialPath}`);
      await flow.startTimespan({ throttlingMethod: 'provided' });
      await definition.perform(page);
      await flow.endTimespan();

      const flowResult = await flow.createFlowResult();
      const timespanStep = [...flowResult.steps]
        .reverse()
        .find((step) => step.lhr.gatherMode === 'timespan');

      if (timespanStep === undefined) {
        throw new Error(`${definition.name} の timespan 結果を取得できませんでした`);
      }

      const tbt = normalizeScore(timespanStep.lhr.audits['total-blocking-time']?.score ?? null);
      const inp = normalizeScore(timespanStep.lhr.audits['experimental-interaction-to-next-paint']?.score ?? null);

      return {
        name: definition.name,
        score: tbt * 0.25 + inp * 0.25,
        tbt,
        inp,
      };
    });

    results.push(result);
    logProgress(`flow done: ${definition.name} (${formatScore(result.score)})`);
  }

  return results;
}

function normalizeScore(score: number | null): number {
  if (typeof score !== 'number') {
    throw new Error('Lighthouse の score を取得できませんでした');
  }

  return score * 100;
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

function sumScores(results: ScoreResult[]): number {
  return results.reduce((total, result) => total + result.score, 0);
}

function printSummary({ pageResults, flowResults }: Summary): void {
  const pageTotal = sumScores(pageResults);
  const flowTotal = sumScores(flowResults);
  const overallTotal = pageTotal + flowTotal;

  console.log('');
  console.log('=== Local Scoring ===');
  console.log('');
  console.log('[Page Landing]');
  for (const result of pageResults) {
    console.log(`${result.name}: ${formatScore(result.score)}`);
  }

  console.log('');
  console.log('[User Flow]');
  for (const result of flowResults) {
    console.log(
      `${result.name}: ${formatScore(result.score)} (TBT ${formatScore(result.tbt)}, INP ${formatScore(result.inp)})`,
    );
  }

  console.log('');
  console.log(`[Total] Pages ${formatScore(pageTotal)} / Flows ${formatScore(flowTotal)} / Overall ${formatScore(overallTotal)}`);
  console.log('');
}

function logProgress(message: string): void {
  console.log(`[score-local] ${message}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
