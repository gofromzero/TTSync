import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const openapiPath = new URL('../contracts/v1/openapi.yaml', import.meta.url);
const eventSchemaPath = new URL('../contracts/v1/room-events.schema.json', import.meta.url);
const generateScriptPath = new URL('../scripts/generate-contract-types.mjs', import.meta.url);
const checkScriptPath = new URL('../scripts/check-contracts.mjs', import.meta.url);

async function loadOpenApi() {
  await SwaggerParser.validate(fileURLToPath(openapiPath));
  return parse(await readFile(openapiPath, 'utf8'));
}

const publicOperationIds = [
  'registerAccount', 'resendVerification', 'verifyEmail', 'login', 'logout',
  'logoutAllSessions', 'requestPasswordReset', 'resetPassword', 'changePassword',
  'changeEmail', 'getSession', 'createTeam', 'listTeams', 'createMember',
  'updateMember', 'createInvitation', 'acceptInvitation', 'createGameProject',
  'updateGameProject', 'createGameProfile', 'updateGameProfile', 'updateRecordTemplate',
  'createRoom', 'joinRoom', 'joinRoomAsSpectator', 'executeRoomCommand',
  'getRoomSnapshot', 'streamRoomInvalidations', 'getGameHistory', 'getGameStatistics',
  'exportGameRecords', 'uploadAvatar', 'getAvatar',
];

function responseSchema(api, name) {
  const schema = api.components.responses[name].content['application/problem+json'].schema;
  return schema.$ref ? api.components.schemas[schema.$ref.split('/').at(-1)] : schema;
}

test('公开合同可由标准解析器独立解析', async () => {
  const api = await loadOpenApi();
  const eventSchema = JSON.parse(await readFile(eventSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  assert.equal(ajv.compile(eventSchema)({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 8 }), true);
  assert.equal(api.info.version, '1.0.0');
});

test('生成与漂移检查复用同一个纯类型生成 seam', async () => {
  for (const path of [generateScriptPath, checkScriptPath]) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /generateContractTypes/);
    assert.doesNotMatch(source, /from 'openapi-typescript'|from 'json-schema-to-typescript'/);
  }
});

test('每个 operation 固定标识、鉴权、请求、成功与完整错误集合', async () => {
  const api = await loadOpenApi();
  const requiredErrors = ['400', '401', '403', '404', '409', '422', '429', '500'];
  for (const pathItem of Object.values(api.paths)) {
    for (const operation of Object.values(pathItem).filter((value) => value?.responses)) {
      assert.match(operation.operationId, /^[a-z][A-Za-z0-9]+$/);
      assert.ok(operation.security?.length > 0);
      assert.ok(operation.parameters?.length > 0 || operation.requestBody);
      assert.ok(operation.responses['200']);
      for (const status of requiredErrors) assert.ok(operation.responses[status], `${operation.operationId} 缺少 ${status}`);
    }
  }
});

test('MVP-01 至 MVP-11 的公开 HTTP operation 完整且稳定', async () => {
  const api = await loadOpenApi();
  const actual = Object.values(api.paths).flatMap((pathItem) =>
    Object.values(pathItem).filter((value) => value?.operationId).map((operation) => operation.operationId));
  assert.deepEqual(actual.sort(), [...publicOperationIds].sort());
});

test('房间命令、成功结果和样例固定并发与幂等语义', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  assert.deepEqual(schemas.RoomCommand.required, ['roomId', 'commandId', 'expectedRevision', 'type', 'payload']);
  assert.deepEqual(schemas.RoomCommandResult.required, ['roomId', 'commandId', 'changed', 'revision']);
  assert.equal(schemas.RoomCommandResult.properties.snapshot, undefined);
  const examples = api.paths['/v1/rooms/{roomId}/commands'].post.requestBody.content['application/json'].examples;
  assert.ok(examples.changedCommand && examples.noChangeCommand && examples.staleRevision && examples.idempotencyFingerprintConflict && examples.multipleViolations);
});

test('命令、结果及角色快照使用封闭的可辨识 union', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  assert.equal(schemas.RoomCommand.discriminator.propertyName, 'type');
  assert.ok(schemas.RoomCommand.oneOf.length >= 8);
  assert.equal(schemas.RoomCommandResult.discriminator.propertyName, 'type');
  assert.ok(schemas.RoomCommandResult.oneOf.length >= 8);
  for (const union of [schemas.RoomCommand, schemas.RoomCommandResult]) {
    for (const branchRef of union.oneOf) {
      let branch = schemas[branchRef.$ref.split('/').at(-1)];
      if (branch.$ref) branch = schemas[branch.$ref.split('/').at(-1)];
      const variant = branch.allOf?.find((item) => item.properties?.type);
      assert.equal(typeof variant?.properties.type.const, 'string');
      const body = variant.properties.payload ?? variant.properties.result;
      assert.equal(body.additionalProperties, false);
    }
  }
  assert.equal(schemas.RoomSnapshot.discriminator.propertyName, 'role');
  assert.equal(schemas.RoomSnapshot.oneOf.length, 3);
  for (const name of ['HostRoomSnapshot', 'ParticipantRoomSnapshot', 'SpectatorRoomSnapshot']) {
    assert.equal(schemas[name].additionalProperties, false);
  }
});

test('Problem Details、状态码语义和快照禁止缓存均已固定', async () => {
  const api = await loadOpenApi();
  const problem = api.components.schemas.ProblemDetails;
  assert.deepEqual(problem.required, ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId']);
  assert.deepEqual(api.components.schemas.Violation.required, ['path', 'code', 'message']);
  const snapshot = api.paths['/v1/rooms/{roomId}/snapshot'].get.responses['200'];
  assert.deepEqual(snapshot.headers['Cache-Control'].schema.enum, ['no-store']);
  assert.match(snapshot.description, /Caddy|浏览器|条件读取/);
});

test('全部错误状态均提供可解析的 Problem Details 样例', async () => {
  const api = await loadOpenApi();
  const responseNames = [
    'BadRequest',
    'Unauthorized',
    'Forbidden',
    'NotFound',
    'Conflict',
    'UnprocessableEntity',
    'TooManyRequests',
    'InternalServerError',
  ];
  for (const name of responseNames) {
    const media = api.components.responses[name].content['application/problem+json'];
    assert.ok(media.example || media.examples, `${name} 缺少 Problem Details 样例`);
  }
});

test('每类错误响应窄化 status/code 并强制所需扩展', async () => {
  const api = await loadOpenApi();
  const expectations = {
    BadRequest: [400, ['MALFORMED_REQUEST']], Unauthorized: [401, ['UNAUTHORIZED']],
    Forbidden: [403, ['FORBIDDEN']], NotFound: [404, ['RESOURCE_NOT_FOUND', 'ROOM_NOT_FOUND']],
    Conflict: [409, ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'STATE_CONFLICT']],
    UnprocessableEntity: [422, ['VALIDATION_FAILED']], TooManyRequests: [429, ['RATE_LIMITED']],
    InternalServerError: [500, ['INTERNAL_ERROR']],
  };
  for (const [name, [status, codes]] of Object.entries(expectations)) {
    const schema = responseSchema(api, name);
    assert.equal(schema.properties.status.const, status, `${name} status 未窄化`);
    assert.deepEqual(schema.properties.code.enum, codes, `${name} code 未窄化`);
  }
  const conflict = responseSchema(api, 'Conflict');
  assert.ok(conflict.oneOf.some((branch) => branch.required?.includes('currentRevision')));
  assert.ok(responseSchema(api, 'UnprocessableEntity').required.includes('violations'));
});

test('失效通知仅允许 roomId/revision，SSE 固定心跳与恢复语义', async () => {
  const eventSchema = JSON.parse(await readFile(eventSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(eventSchema);
  assert.equal(validate({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 9 }), true);
  assert.equal(validate({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 9, payload: {} }), false);
  const api = await loadOpenApi();
  const response = api.paths['/v1/rooms/{roomId}/events'].get.responses['200'];
  const stream = response.content['text/event-stream'];
  assert.equal(response['x-sse-heartbeat-interval-seconds'], 15);
  assert.equal(response['x-sse-heartbeat-format'], ': heartbeat');
  assert.equal(response['x-sse-event-id'], 'revision');
  assert.match(response.description, /完整快照/);
  assert.match(response.description, /历史/);
  assert.deepEqual(response['x-sse-subscription-order'], ['subscribe', 'read-current-revision', 'send-current-revision']);
  assert.equal(response['x-sse-listener-failure-action'], 'close-stream-for-reconnect');
});
