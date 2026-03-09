import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { navigation, startFlow } from 'lighthouse';
import puppeteer from 'puppeteer';

const DEFAULT_PORT = 4173;
const TARGET_URL = new URL(process.env.SCORING_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`);
const BASE_URL = TARGET_URL.origin;
const PORT_TEXT = process.env.SCORING_PORT ?? TARGET_URL.port;
const PORT = Number(PORT_TEXT || DEFAULT_PORT);
const PRODUCT_PATH = process.env.SCORING_PRODUCT_PATH ?? '/product/1';
const NOT_FOUND_PATH = process.env.SCORING_NOT_FOUND_PATH ?? '/__local-scoring-not-found__';
const SHOULD_MANAGE_SERVER = TARGET_URL.hostname === '127.0.0.1' || TARGET_URL.hostname === 'localhost';

const PAGE_CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
  },
};

const FLOW_CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: ['total-blocking-time', 'experimental-interaction-to-next-paint'],
    throttlingMethod: 'provided',
  },
};

const SEEDED_USER = {
  email: 'miyamori_aoi@example.com',
  password: 'miyamori_aoi',
};

async function main() {
  let serverProcess;

  try {
    if (SHOULD_MANAGE_SERVER) {
      logProgress('build start');
      await runScript('build');
      logProgress('build done');
      logProgress(`server start (${BASE_URL})`);
      serverProcess = startServer();
      await waitForServer(BASE_URL, serverProcess);
      logProgress('server ready');
    } else {
      logProgress(`use existing target (${BASE_URL})`);
    }

    const browser = await puppeteer.launch({
      executablePath: puppeteer.executablePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const pageResults = await measurePageLandingScores(browser);
      const flowResults = await measureUserFlowScores(browser);

      printSummary({ pageResults, flowResults });
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer(serverProcess);
  }
}

async function measurePageLandingScores(browser) {
  const definitions = [
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

  const results = [];

  for (const definition of definitions) {
    await resetDatabase();
    logProgress(`page start: ${definition.name}`);
    const result = await withIsolatedPage(browser, async (page) => {
      if (definition.setup) {
        await definition.setup(page);
      }

      const runnerResult = await navigation(page, `${BASE_URL}${definition.path}`, {
        config: PAGE_CONFIG,
        flags: definition.flags,
      });
      const lhr = runnerResult?.lhr;

      if (!lhr) {
        throw new Error(`${definition.name} の Lighthouse 結果を取得できませんでした`);
      }

      return {
        name: definition.name,
        score: normalizeScore(lhr.categories.performance.score),
      };
    });

    results.push(result);
    logProgress(`page done: ${definition.name} (${formatScore(result.score)})`);
  }

  return results;
}

async function measureUserFlowScores(browser) {
  const definitions = [
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
        await signUp(page);
        await clickByXPath(page, "//button[normalize-space()='カートに追加']");
        await page.waitForXPath("//*[contains(normalize-space(), 'カートに追加済み')]");
        await clickByXPath(page, "//a[normalize-space()='購入手続きへ']");
        await waitForPathname(page, '/order');
        await submitOrder(page);
      },
    },
  ];

  const results = [];

  for (const definition of definitions) {
    await resetDatabase();
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

      if (!timespanStep) {
        throw new Error(`${definition.name} の timespan 結果を取得できませんでした`);
      }

      const tbt = normalizeScore(timespanStep.lhr.audits['total-blocking-time'].score);
      const inp = normalizeScore(timespanStep.lhr.audits['experimental-interaction-to-next-paint'].score);

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

async function signIn(page, user) {
  await page.waitForSelector('[data-testid="navigate-signin"]', { visible: true });
  await page.click('[data-testid="navigate-signin"]');
  await page.waitForSelector('[data-testid="modal"] #email');

  await clearAndType(page, '#email', user.email);
  await clearAndType(page, '#password', user.password);
  await clickByXPath(page, "//div[@data-testid='modal']//button[normalize-space()='ログイン']");

  await waitForModalToClose(page);
  await page.waitForSelector('[data-testid="navigate-order"]', { visible: true });
}

async function signUp(page) {
  const uniqueSuffix = Date.now().toString(36);
  const email = `local-score-${uniqueSuffix}@example.com`;
  const password = `Local!Score-${uniqueSuffix}`;

  await page.waitForSelector('[data-testid="navigate-signin"]', { visible: true });
  await page.click('[data-testid="navigate-signin"]');
  await page.waitForSelector('[data-testid="modal"]');
  await page.click('[data-testid="modal-switch-to-signup"]');
  await page.waitForXPath("//div[@data-testid='modal']//h2[normalize-space()='会員登録']");

  await clearAndType(page, '#email', email);
  await clearAndType(page, '#name', 'Local Scoring');
  await clearAndType(page, '#password', password);
  await clickByXPath(page, "//div[@data-testid='modal']//button[normalize-space()='登録する']");

  await waitForModalToClose(page);
  await page.waitForSelector('[data-testid="navigate-order"]', { visible: true });
}

async function submitOrder(page) {
  await page.waitForSelector('[data-testid="order-form"] #zipCode');
  await clearAndType(page, '#zipCode', '1500042');
  await page.waitForFunction(() => {
    const prefecture = document.querySelector('#prefecture');
    const city = document.querySelector('#city');
    return prefecture instanceof HTMLInputElement && city instanceof HTMLInputElement && prefecture.value !== '' && city.value !== '';
  });
  await clearAndType(page, '#streetAddress', '40番1号 Abema Towers');
  await clickByXPath(page, "//form[@data-testid='order-form']//button[normalize-space()='購入']");
  await waitForPathname(page, '/order/complete');
}

async function withIsolatedPage(browser, callback) {
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

async function runScript(scriptName) {
  await runCommand(resolveRunnerBinary(), [scriptName], {
    env: process.env,
  });
}

function startServer() {
  const serverProcess = spawn(resolveRunnerBinary(), ['start:server:once'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.setEncoding('utf8');
  serverProcess.stderr.setEncoding('utf8');

  let output = '';
  serverProcess.stdout.on('data', (chunk) => {
    output += chunk;
  });
  serverProcess.stderr.on('data', (chunk) => {
    output += chunk;
  });

  serverProcess.output = () => output;

  return serverProcess;
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode != null) {
    return;
  }

  try {
    process.kill(-serverProcess.pid, 'SIGTERM');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }

  await Promise.race([
    once(serverProcess, 'exit'),
    delay(10_000).then(() => {
      try {
        process.kill(-serverProcess.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
      return once(serverProcess, 'exit');
    }),
  ]);
}

async function waitForServer(baseUrl, serverProcess) {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    if (serverProcess.exitCode != null) {
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

async function resetDatabase() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/initialize`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`/initialize に失敗しました: ${response.status}`);
      }

      return;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }

      await delay(1_000);
    }
  }
}

async function clearAndType(page, selector, value) {
  await page.waitForSelector(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

async function countReviews(page) {
  return page.$$eval('[data-testid="review-list-item"]', (items) => items.length);
}

async function waitForReviewCount(page, expectedCount) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="review-list-item"]').length >= count,
    {},
    expectedCount,
  );
}

async function waitForModalToClose(page) {
  await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'));
}

async function waitForPathname(page, pathname) {
  await page.waitForFunction((expectedPathname) => window.location.pathname === expectedPathname, {}, pathname);
}

async function clickByXPath(page, xpath) {
  const handle = await waitForXPath(page, xpath);
  await handle.click();
}

async function waitForXPath(page, xpath) {
  const handle = await page.waitForXPath(xpath);

  if (!handle) {
    throw new Error(`要素が見つかりません: ${xpath}`);
  }

  return handle;
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
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

function resolveRunnerBinary() {
  return process.platform === 'win32' ? 'nr.cmd' : 'nr';
}

function normalizeScore(score) {
  if (typeof score !== 'number') {
    throw new Error('Lighthouse の score を取得できませんでした');
  }

  return score * 100;
}

function formatScore(score) {
  return score.toFixed(3);
}

function sumScores(results) {
  return results.reduce((total, result) => total + result.score, 0);
}

function printSummary({ pageResults, flowResults }) {
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

function logProgress(message) {
  console.log(`[score-local] ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
