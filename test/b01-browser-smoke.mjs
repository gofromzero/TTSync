import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

test('B-01 真实 Chromium HTTPS 验收', {
  skip: process.env.B01_RUN_BROWSER_SMOKE !== '1',
}, async () => {
  const baseUrl = process.env.B01_BASE_URL ?? 'https://localhost:8443';
  const baseOrigin = new URL(baseUrl).origin;
  const expectedNavigationStatus = Number(process.env.B01_EXPECT_NAVIGATION_STATUS ?? 0);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const requests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== baseOrigin) requests.push(request.url());
    });
    const healthResponses = [];
    const navigationResponses = [];
    page.on('response', (response) => {
      if (response.url() === baseUrl) navigationResponses.push(response.status());
      if (response.url() === `${baseUrl}/health/live` || response.url() === `${baseUrl}/health/ready`) {
        healthResponses.push([response.url(), response.status()]);
      }
    });
    await page.goto(baseUrl);
    if (expectedNavigationStatus !== 0) {
      assert.deepEqual(navigationResponses, [expectedNavigationStatus]);
      assert.deepEqual(requests, []);
      if (expectedNavigationStatus < 400) assert.deepEqual(consoleErrors, []);
      return;
    }

    assert.equal(await page.title(), 'TTSync');
    const expectedInteractiveControls = ['主持人视图', '参与者视图', '观众视图'];
    const interactiveControls = await page.getByRole('tab').allTextContents();
    assert.deepEqual(interactiveControls, expectedInteractiveControls);

    for (const [role, explanation] of [
      ['主持人视图', '组织当前房间'],
      ['参与者视图', '查看自己的桌面信息'],
      ['观众视图', '只读关注当前进展'],
    ]) {
      await page.getByRole('tab', { name: role }).click();
      await page.getByText(explanation, { exact: false }).waitFor();
    }

    const liveResponse = page.waitForResponse((response) => response.url() === `${baseUrl}/health/live`);
    const readyResponse = page.waitForResponse((response) => response.url() === `${baseUrl}/health/ready`);
    await page.evaluate((url) => {
      for (const path of ['/health/live', '/health/ready']) {
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.src = `${url}${path}`;
        document.body.append(frame);
      }
    }, baseUrl);
    await liveResponse;
    await readyResponse;
    healthResponses.sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(healthResponses, [
      [`${baseUrl}/health/live`, 200],
      [`${baseUrl}/health/ready`, 200],
    ]);
    assert.deepEqual(requests, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
  }
});
