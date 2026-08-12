import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium } from 'playwright';

test('ID-01 注册与邮箱验证真实 Chromium HTTPS 验收', {
  skip: process.env.B01_RUN_BROWSER_SMOKE !== '1',
}, async () => {
  const baseUrl = process.env.B01_BASE_URL ?? 'https://localhost:8443';
  const baseOrigin = new URL(baseUrl).origin;
  const composeProject = process.env.ID01_COMPOSE_PROJECT;
  const composeFile = process.env.ID01_COMPOSE_FILE;
  assert.ok(composeProject && composeFile, 'ID-01 smoke 必须使用 smoke-b01 提供的精确 Compose 环境');

  const composeExec = (service, ...command) => execFileSync('docker', [
    'compose', '-p', composeProject, '-f', composeFile, 'exec', '-T', service, ...command,
  ], { encoding: 'utf8', windowsHide: true });
  const readOutbox = () => {
    const output = composeExec('app', 'sh', '-c', `
set -eu
stat -c %a /tmp/ttsync-outbox
for file in /tmp/ttsync-outbox/*.eml; do
  [ -f "$file" ] || continue
  printf '===FILE:%s===\\n' "\${file##*/}"
  stat -c %a "$file"
  cat "$file"
  printf '\\n===END===\\n'
done`);
    const [directoryMode, ...lines] = output.split(/\r?\n/);
    const messages = [];
    const body = lines.join('\n');
    for (const match of body.matchAll(/^===FILE:([^=]+)===\n(\d+)\n([\s\S]*?)\n===END===$/gm)) {
      messages.push({ name: match[1], mode: match[2], body: match[3] });
    }
    return { directoryMode, messages };
  };
  const accountState = (email) => composeExec(
    'postgres',
    'psql', '-U', 'ttsync', '-d', 'ttsync', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1',
    '-c', `SELECT count(*), min(status) FROM accounts WHERE email_normalized = '${email}'`,
  ).trim();

  const email = `slice4.${Date.now()}.${randomUUID()}@example.test`;
  const password = 'BrowserSmoke!2026';
  const acceptedMessage = '请求已受理，请查收邮件。';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const consoleErrors = [];
    const expectedReplayConsoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('status of 422')) consoleErrors.push(message.text());
      if (message.type() === 'error' && message.text().includes('status of 422')) expectedReplayConsoleErrors.push(message.text());
    });
    const externalRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== baseOrigin) externalRequests.push(request.url());
    });
    const apiResponses = [];
    page.on('response', (response) => {
      if (new URL(response.url()).origin === baseOrigin && response.request().method() === 'POST') {
        apiResponses.push([new URL(response.url()).pathname, response.status()]);
      }
    });

    await page.goto(baseUrl);
    await page.getByLabel('注册邮箱').fill(email);
    await page.getByLabel('注册密码').fill(password);
    const firstRegisterResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/accounts');
    await page.getByRole('button', { name: '注册账号' }).click();
    assert.equal((await firstRegisterResponse).status(), 200);
    await page.getByText(acceptedMessage, { exact: true }).waitFor();
    assert.equal(accountState(email), '1|pending_verification');

    const firstOutbox = readOutbox();
    assert.equal(firstOutbox.directoryMode, '700');
    assert.ok(firstOutbox.messages.length > 0, '首次注册必须投递验证邮件');
    assert.ok(firstOutbox.messages.every((message) => message.mode === '600'), 'outbox 邮件权限必须全部为 600');
    const linkedMessages = firstOutbox.messages.filter((message) => /^Verify your email: https:\/\/[^\s]+\/verify\?token=[^\s]+$/m.test(message.body));
    assert.equal(linkedMessages.length, 1, '首次注册必须恰好产生一封验证链接邮件');
    assert.ok(firstOutbox.messages.filter((message) => message.body.includes('Your request was received.')).every((message) => !message.body.includes('/verify?token=')), '通用回执不得误作 token 邮件');
    const verificationLink = linkedMessages[0].body.match(/^Verify your email: (https:\/\/[^\s]+\/verify\?token=[^\s]+)$/m)?.[1];
    assert.ok(verificationLink?.startsWith(`${baseUrl}/verify?token=`), '验证链接必须使用当前 HTTPS origin');
    const token = new URL(verificationLink).searchParams.get('token');
    assert.ok(token, '验证链接必须携带 token');

    const verifyResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/accounts/verification');
    await page.goto(verificationLink);
    assert.equal((await verifyResponse).status(), 200);
    await page.getByText('邮箱已验证。', { exact: true }).waitFor();
    assert.equal(accountState(email), '1|active');

    await new Promise((resolve) => setTimeout(resolve, 61_000));
    const replayResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/accounts/verification');
    await page.goto(verificationLink);
    const replay = await replayResponse;
    assert.equal(replay.status(), 422);
    assert.equal((await replay.json()).code, 'VALIDATION_FAILED');
    await page.getByText('验证链接无效或已失效。', { exact: true }).waitFor();
    assert.equal(expectedReplayConsoleErrors.length, 1);
    assert.match(expectedReplayConsoleErrors[0], /^Failed to load resource: the server responded with a status of 422/);

    const beforeDuplicateNames = new Set(firstOutbox.messages.map((message) => message.name));
    await page.goto(baseUrl);
    await page.getByLabel('注册邮箱').fill(email);
    await page.getByLabel('注册密码').fill(password);
    const duplicateResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/accounts');
    await page.getByRole('button', { name: '注册账号' }).click();
    assert.equal((await duplicateResponse).status(), 200);
    await page.getByText(acceptedMessage, { exact: true }).waitFor();
    assert.equal(accountState(email), '1|active');

    const finalOutbox = readOutbox();
    assert.equal(finalOutbox.directoryMode, '700');
    assert.ok(finalOutbox.messages.every((message) => message.mode === '600'), 'outbox 邮件权限必须全部为 600');
    const duplicateMessages = finalOutbox.messages.filter((message) => !beforeDuplicateNames.has(message.name));
    assert.equal(duplicateMessages.length, 1, '重复注册必须只新增一封通用邮件');
    assert.match(duplicateMessages[0].body, /Your request was received\./);
    assert.doesNotMatch(duplicateMessages[0].body, /\/verify\?token=/);

    const appLogs = execFileSync('docker', [
      'compose', '-p', composeProject, '-f', composeFile, 'logs', '--no-color', 'app',
    ], { encoding: 'utf8', windowsHide: true });
    const cookies = await context.cookies();
    for (const secret of [password, token, ...cookies.map((cookie) => cookie.value)].filter(Boolean)) {
      assert.ok(!appLogs.includes(secret), 'app 日志不得包含测试秘密或会话标识');
    }
    assert.deepEqual(apiResponses, [
      ['/api/v1/accounts', 200],
      ['/api/v1/accounts/verification', 200],
      ['/api/v1/accounts/verification', 422],
      ['/api/v1/accounts', 200],
    ]);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
  }
});
