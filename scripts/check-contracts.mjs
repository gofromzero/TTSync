import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { eventSchemaUrl, generateContractTypes, openapiUrl } from './contract-generation.mjs';

const generatedUrl = new URL('../contracts/v1/generated/api.ts', import.meta.url);
const generatedEventUrl = new URL('../contracts/v1/generated/room-events.ts', import.meta.url);

await SwaggerParser.validate(fileURLToPath(openapiUrl));

const { apiTypes: expected, eventSchema, eventTypes: expectedEvent } = await generateContractTypes();
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.compile(eventSchema);

const committed = await readFile(generatedUrl, 'utf8');
assert.equal(
  committed,
  expected,
  '生成的 TypeScript 类型已漂移；请运行 npm run contracts:generate 后提交结果。',
);

assert.equal(
  await readFile(generatedEventUrl, 'utf8'),
  expectedEvent,
  '生成的房间失效通知 TypeScript 类型已漂移；请运行 npm run contracts:generate 后提交结果。',
);

const tests = spawnSync(process.execPath, ['--test', 'test/contracts.test.mjs'], { stdio: 'inherit' });
if (tests.error) throw tests.error;
if (tests.status !== 0) process.exit(tests.status ?? 1);

console.log('合同解析、语义测试与 TypeScript 漂移检查通过。');
