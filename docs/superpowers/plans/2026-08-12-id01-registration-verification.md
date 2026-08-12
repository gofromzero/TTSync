# ID-01 Registration And Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 经真实 PostgreSQL、Caddy HTTPS 与测试邮件完成公开注册、重发和一次性邮箱验证，不泄露账号是否存在。

**Architecture:** `identity` Module 以一个目标型 Interface 拥有邮箱、密码、令牌和安全事件规则；PostgreSQL 是并发唯一性与令牌消费的权威。Chi 只做 anonymous-CSRF、DTO 与 Problem Details 映射；同一 Vue 客户端提供注册和验证视图；测试 outbox 是邮件 Adapter，不创建公开 outbox HTTP endpoint。

**Tech Stack:** Go 1.25、Chi v5、pgx/v5 + sqlc、PostgreSQL 17、Argon2id、Vue 3、Playwright、Docker Compose。

## Global Constraints

- 邮箱去首尾空白后保留展示写法，唯一键为整体小写；唯一性必须由 PostgreSQL 收敛。
- 密码原样处理，只接受 15–128 个可打印 Unicode code point，并拒绝仓库内固定小型泄露密码清单。
- 验证令牌使用 CSPRNG，24 小时、单次、分用途、代次递增；数据库只存 SHA-256 摘要。
- 注册与重发使用相同通用受理响应；验证失败统一为 `token_invalid_or_expired`，不区分过期、重放、用途错误或旧代。
- anonymous CSRF 使用同源 cookie + header；不新增 token 获取 API。
- 邮件投递失败保留 pending 账号和可重发令牌，不伪装为已验证。
- 不实现登录/会话、密码恢复、邮箱变更、邀请解析、团队、SSE、Redis 或 CAPTCHA。

---

### Task 1: 修正公开注册合同

**Files:**
- Modify: `contracts/v1/openapi.yaml`
- Modify: `contracts/v1/generated/api.ts`
- Modify: `test/contracts.test.mjs`

**Interfaces:**
- Produces: 三个冻结 operation；注册与重发返回 `{accepted: true}`，验证返回 `{verified: true}`。

- [ ] 先写合同失败测试，证明注册响应不得包含 `accountId`，重发与注册均为通用受理。
- [ ] 运行 `node --test test/contracts.test.mjs` 取得预期 RED。
- [ ] 最小修改 OpenAPI 并运行 `npm run contracts:generate`。
- [ ] 运行 `npm run contracts:check` 取得 GREEN，中文提交。

### Task 2: 交付 identity Module 与真实 PostgreSQL

**Files:**
- Create: `db/migrations/000002_identity_registration.sql`
- Create: `db/queries/identity/registration.sql`
- Modify: `db/sqlc.yaml`
- Create/Modify: `internal/identity/*.go`
- Modify: `scripts/test-go.ps1`

**Interfaces:**
- Produces: `identity.Module` 的 `Register`、`ResendVerification`、`VerifyEmail` 三个目标命令；调用者只见命令、结果和稳定错误。
- Consumes: PostgreSQL pool、`Clock.Now()`、`Mailer.SendVerification(...)`、安全随机源。

- [ ] 先写纯领域 RED：邮箱/Unicode 密码/泄露清单/令牌摘要与期限。
- [ ] 写真实 PostgreSQL RED：并发同邮箱唯一、代次替换、过期/重放/用途错/并发消费、审计白名单。
- [ ] 添加最小 migration/sqlc 与 Module implementation；不建立通用 repository Interface。
- [ ] 运行定向 unit/integration 与 `npm run db:generate` 取得 GREEN，中文提交。

### Task 3: 接通 HTTP、CSRF、邮件和应用组装

**Files:**
- Modify: `internal/httpapi/router.go`, `router_test.go`
- Modify: `internal/app/runtime.go`, `runtime_test.go`
- Create: `internal/platform/mail/*.go`
- Modify: `cmd/ttsync/main.go`

**Interfaces:**
- Consumes: `identity.Module` 三个目标命令。
- Produces: `/api/v1/accounts`、`/verification/resend`、`/verification`；首屏 anonymous-CSRF cookie；测试 outbox 仅进程内可读。

- [ ] 先写 handler RED：CSRF、严格 JSON、通用响应、稳定 Problem Details、日志秘密缺失。
- [ ] 写邮件失败 RED，证明 pending 状态可重发且未验证。
- [ ] 最小接线并取得 handler/app GREEN，中文提交。

### Task 4: 注册/验证网页与真实浏览器闭环

**Files:**
- Modify: `clients/web/src/App.vue`, `main.ts`, `style.css`
- Create: `test/id01-browser-smoke.mjs`
- Modify: `deployments/compose.yaml`, `Dockerfile`
- Create/Modify: `scripts/smoke-id01.ps1`, `package.json`, `package-lock.json`, `README.md`

**Interfaces:**
- Produces: `npm run smoke:id01`，仍只启动 `app + postgres + caddy`。

- [ ] 先写 Playwright RED：注册、读取测试邮件、验证、重放失败、重复注册通用反馈。
- [ ] 在现有单页客户端添加最小可访问表单；不引入路由库或状态库。
- [ ] 通过受限测试夹具取得 outbox 内容，不提供生产公开端点。
- [ ] 运行真实 Caddy/PostgreSQL/Chromium GREEN，验证日志无密码/完整令牌，中文提交。

### Task 5: 最终验证与双轴复核

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: fixed point `433a1f9` and GitHub #31.
- Produces: clean reviewed branch and fresh verification evidence.

- [ ] 运行 contracts/MVP/structure/sqlc/web/Go/vet/真实 PostgreSQL/ID01 smoke/diff-check。
- [ ] Standards 与 Spec 两轴并行只读复核；任何 P0/P1/P2 先 RED→GREEN 修复。
- [ ] 中文提交，推送 `gofromzero/issue-31-id01`，评论并仅在全部验收有证据时关闭 #31。
