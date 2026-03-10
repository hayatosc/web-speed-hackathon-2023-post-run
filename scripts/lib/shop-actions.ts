import type { Page } from 'puppeteer';

export const SEEDED_USER = {
  email: 'miyamori_aoi@example.com',
  password: 'miyamori_aoi',
};

export type UserCredential = {
  email: string;
  password: string;
};

type SignUpOptions = {
  emailPrefix?: string;
  name?: string;
  passwordPrefix?: string;
};

export async function signIn(page: Page, user: UserCredential): Promise<void> {
  await openSignInModal(page);

  await clearAndType(page, '#email', user.email);
  await clearAndType(page, '#password', user.password);
  await clickByXPath(page, "//div[@data-testid='modal']//button[normalize-space()='ログイン']");

  await waitForModalToClose(page);
  await page.waitForSelector('[data-testid="navigate-order"]', { visible: true });
}

export async function signUp(page: Page, options: SignUpOptions = {}): Promise<void> {
  const uniqueSuffix = Date.now().toString(36);
  const emailPrefix = options.emailPrefix ?? 'local-user';
  const displayName = options.name ?? 'Local User';
  const passwordPrefix = options.passwordPrefix ?? 'Local!User';
  const email = `${emailPrefix}-${uniqueSuffix}@example.com`;
  const password = `${passwordPrefix}-${uniqueSuffix}`;

  await openSignInModal(page);
  await switchToSignUpModal(page);

  await setInputValueByXPath(page, "//div[@data-testid='modal']//input[@id='email']", email);
  await setInputValueByXPath(page, "//div[@data-testid='modal']//input[@id='name']", displayName);
  await setInputValueByXPath(page, "//div[@data-testid='modal']//input[@id='password']", password);
  await clickByXPath(page, "//div[@data-testid='modal']//button[normalize-space()='登録する']");

  await waitForModalToClose(page);
  await page.waitForSelector('[data-testid="navigate-order"]', { visible: true });
}

export async function submitOrder(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="order-form"] #zipCode');
  await clearAndType(page, '#zipCode', '1500042');
  await page.waitForFunction(() => {
    const prefecture = document.querySelector('#prefecture');
    const city = document.querySelector('#city');
    return (
      prefecture instanceof HTMLInputElement &&
      city instanceof HTMLInputElement &&
      prefecture.value !== '' &&
      city.value !== ''
    );
  });
  await clearAndType(page, '#streetAddress', '40番1号 Abema Towers');
  await clickByXPath(page, "//form[@data-testid='order-form']//button[normalize-space()='購入']");
  await waitForPathname(page, '/order/complete');
}

export async function clearAndType(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

export async function countReviews(page: Page): Promise<number> {
  return page.$$eval('[data-testid="review-list-item"]', (items) => items.length);
}

export async function waitForReviewCount(page: Page, expectedCount: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="review-list-item"]').length >= count,
    {},
    expectedCount,
  );
}

export async function waitForModalToClose(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('[data-testid="modal"]') === null);
}

export async function waitForPathname(page: Page, pathname: string): Promise<void> {
  await page.waitForFunction((expectedPathname) => window.location.pathname === expectedPathname, {}, pathname);
}

export async function waitForText(page: Page, text: string): Promise<void> {
  await page.waitForFunction((expectedText) => document.body?.innerText.includes(expectedText) ?? false, {}, text);
}

export async function clickByXPath(page: Page, xpath: string): Promise<void> {
  await page.waitForFunction(
    (expression) => {
      const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue;
      return result instanceof HTMLElement || result instanceof SVGElement;
    },
    {},
    xpath,
  );

  await page.evaluate((expression) => {
    const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue;

    if (!(result instanceof HTMLElement) && !(result instanceof SVGElement)) {
      throw new Error(`要素が見つかりません: ${expression}`);
    }

    result.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, xpath);
}

async function openSignInModal(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="navigate-signin"]', { visible: true });
  await clickWithRetry(
    page,
    async () => {
      await clickByXPath(page, "//*[@data-testid='navigate-signin']");
    },
    async () => {
      await page.click('[data-testid="navigate-signin"]');
    },
    async () => {
      await page.waitForSelector('[data-testid="modal"] #email', { timeout: 5_000 });
    },
  );
}

async function switchToSignUpModal(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="modal"]');
  await clickWithRetry(
    page,
    async () => {
      await clickByXPath(page, "//*[@data-testid='modal-switch-to-signup']");
    },
    async () => {
      await page.click('[data-testid="modal-switch-to-signup"]');
    },
    async () => {
      await page.waitForXPath("//div[@data-testid='modal']//h2[normalize-space()='会員登録']", { timeout: 5_000 });
    },
  );
}

async function clickWithRetry(
  page: Page,
  primaryAction: () => Promise<void>,
  fallbackAction: () => Promise<void>,
  waitForTarget: () => Promise<unknown>,
): Promise<void> {
  let lastError: unknown;

  for (const action of [primaryAction, fallbackAction]) {
    try {
      await action();
      await waitForTarget();
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  throw lastError;
}

async function setInputValueByXPath(page: Page, xpath: string, value: string): Promise<void> {
  await page.waitForFunction(
    (expression) => {
      const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue;
      return result instanceof HTMLInputElement || result instanceof HTMLTextAreaElement;
    },
    {},
    xpath,
  );

  await page.evaluate(
    (expression, nextValue) => {
      const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue;

      if (!(result instanceof HTMLInputElement) && !(result instanceof HTMLTextAreaElement)) {
        throw new Error(`入力要素が見つかりません: ${expression}`);
      }

      result.focus();
      result.value = '';
      result.dispatchEvent(new Event('input', { bubbles: true }));
      result.value = nextValue;
      result.dispatchEvent(new Event('input', { bubbles: true }));
      result.dispatchEvent(new Event('change', { bubbles: true }));
    },
    xpath,
    value,
  );
}
