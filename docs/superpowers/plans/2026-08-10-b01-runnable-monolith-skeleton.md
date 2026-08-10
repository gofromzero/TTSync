# B-01 可运行模块化单体纵向骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从全新检出启动且仅启动 `app + postgres + caddy`，经本地 HTTPS 提供嵌入式 Vue 三角色空壳、应用/数据库健康检查，以及可重复的迁移、sqlc、Go、前端、合同和真实浏览器验收入口。

**Architecture:** `cmd/ttsync` 只组装 `internal/app`；`internal/app` 建立 PostgreSQL adapter 与 Chi adapter，四个领域 Module 保持独立包且不让 `httpapi` 承担权限或事务规则。Vue 构建产物写入 Go embed 包；Caddy 是唯一公开入口；真实 PostgreSQL readiness 与浏览器 smoke 通过 Compose 验收。

**Tech Stack:** Go 1.25、Chi v5、pgx/v5、sqlc、PostgreSQL 17、Vue 3.5、TypeScript 5.9、Vite 8、Caddy 2、Docker Compose、Playwright 1.62。

## Global Constraints

- Compose 恰好包含 `app`、`postgres`、`caddy` 三个 service，不加入 Redis、Kafka、PgBouncer、Grafana、Prometheus 或独立静态站点容器。
- Chi 仅解析 HTTP 和映射结果；事务、权限、容量、认领和快照规则不进入 `internal/httpapi`。
- `identity`、`team`、`activity`、`reporting` 是四个深 Module；业务规则不得复制到 `clients/web`。
- B-01 只提供健康页和空角色壳，不提前实现任何领域命令、表级 CRUD 或未被消费的 repository port。
- PostgreSQL 是集成验收的真实 adapter；数据库健康不得由 mock 证明。
- 网页构建产物通过 `go:embed` 进入 Go 二进制，Caddy 只做 HTTPS 和反向代理。
- 运行配置与测试凭据分离；仓库只保存 `.example` 和 `TEST_ONLY` 值，不保存真实秘密。
- 公共 TDD seam 固定为 HTTPS `/health/live`、HTTPS `/health/ready`、HTTPS `/`、迁移命令、sqlc 生成命令、Go 测试命令、前端类型检查、合同漂移检查和真实浏览器 smoke。

---

## File Map

- `cmd/ttsync/main.go`: 读取环境、启动/关闭应用 runtime。
- `cmd/migrate/main.go`: 对真实 PostgreSQL 执行嵌入式前向迁移。
- `internal/app/runtime.go`: 唯一 composition root，持有数据库池、HTTP server 生命周期。
- `internal/{identity,team,activity,reporting}/doc.go`: 声明 Module 责任，不创建虚假业务 interface。
- `internal/httpapi/router.go`: Chi 路由、健康响应、嵌入式 SPA fallback。
- `internal/httpapi/web.go` 与 `internal/httpapi/web/dist/*`: Go embed seam 与确定性 Vue 构建产物。
- `internal/platform/postgres/pool.go`: pgxpool 配置、真实 readiness 查询。
- `internal/platform/postgres/migrate.go`: advisory lock、顺序、校验和、单迁移事务。
- `internal/platform/postgres/sqlc/*`: sqlc 生成的 `SELECT 1` 健康查询 adapter。
- `db/migrations/000001_platform_schema_migrations.sql`: 有实际消费者的迁移账本。
- `db/queries/platform/health.sql` 与 `db/sqlc.yaml`: readiness 查询及生成配置。
- `clients/web/*`: Vue 三角色空壳、类型检查和 Vite 构建。
- `deployments/{compose.yaml,Caddyfile,Dockerfile,.env.example}`: 三容器运行面。
- `scripts/{generate-sqlc.ps1,build-web.ps1,test-go.ps1,smoke-b01.ps1}`: 唯一 Windows/CI 入口。
- `test/b01-architecture.test.mjs`: 服务数、依赖方向、秘密与脚本契约。
- `test/b01-browser-smoke.mjs`: Playwright 经 Caddy HTTPS 验证真实页面与健康。

### Task 1: 固定 B-01 可执行验收合同

**Files:**
- Create: `test/b01-architecture.test.mjs`
- Create: `scripts/smoke-b01.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes: GitHub #30 的四条 acceptance criteria 与本计划 Global Constraints。
- Produces: `npm run test:b01:structure` 和 `npm run smoke:b01` 两个公开命令。

- [ ] **Step 1: 写结构合同 RED**

  Node 测试必须解析 `deployments/compose.yaml` 并断言 service key 严格等于 `app,caddy,postgres`；检查 `go.mod`、`db/sqlc.yaml`、四个领域包、`clients/web/package.json`、`scripts/smoke-b01.ps1` 存在；扫描 `internal/httpapi/**/*.go` 不得出现 `administrator|host|claim|capacity` 权限分支。

- [ ] **Step 2: 运行 RED**

  Run: `node --test test/b01-architecture.test.mjs`

  Expected: FAIL，首个缺失项为 `deployments/compose.yaml`。

- [ ] **Step 3: 固定 smoke 编排接口**

  `scripts/smoke-b01.ps1` 接受 `-BaseUrl https://localhost:8443`，设置进程级 `TEST_ONLY` 数据库凭据，依次执行 `docker compose config --services`、build/up、迁移、带真实 DSN 的 Go integration test、Playwright smoke，并在 `finally` 执行 `docker compose down -v --remove-orphans`。

- [ ] **Step 4: 把命令接入根 package scripts**

  新增 `test:b01:structure`、`db:generate`、`db:migrate:test`、`test:go`、`web:typecheck`、`web:build`、`smoke:b01`；保留现有 `test:contracts` 与 `test:mvp-acceptance`，根 `test` 串联合同、MVP 和 B-01 结构合同。

- [ ] **Step 5: 再跑 RED 并记录失败边界**

  Run: `npm run test:b01:structure`

  Expected: FAIL，仅因尚未创建的产品/部署文件，不得因测试语法失败。

### Task 2: 建立 Go composition root、Chi 健康 seam 与真实 pgx readiness

**Files:**
- Create: `go.mod`, `go.sum`
- Create: `cmd/ttsync/main.go`
- Create: `internal/app/runtime.go`, `internal/app/runtime_test.go`
- Create: `internal/httpapi/router.go`, `internal/httpapi/router_test.go`
- Create: `internal/platform/postgres/pool.go`, `internal/platform/postgres/pool_integration_test.go`
- Create: `internal/{identity,team,activity,reporting}/doc.go`

**Interfaces:**
- Consumes: `DATABASE_URL`, `HTTP_ADDR`。
- Produces: `httpapi.New(httpapi.Config{Ready func(context.Context) error, Web fs.FS}) http.Handler`；`postgres.Open(context.Context,string) (*pgxpool.Pool,error)`；`app.Run(context.Context, app.Config) error`。

- [ ] **Step 1: 写 Chi seam RED**

  `router_test.go` 通过 `httptest` 断言 `/health/live` 总是 `200 {"status":"live"}`；readiness adapter 返回 nil 时 `/health/ready` 为 200，返回错误时为 `503 {"status":"not_ready"}`；响应使用 `application/json`。

- [ ] **Step 2: 运行 RED**

  Run: `go test ./internal/httpapi -run Health -count=1`

  Expected: FAIL，`httpapi.New` 尚不存在。

- [ ] **Step 3: 最小 GREEN Chi router**

  用 `chi.NewRouter()` 只注册 health 与 SPA handler；Ready 函数是 HTTP seam 的唯一依赖，router 不导入四个领域 Module 或 pgx。

- [ ] **Step 4: 真实 PostgreSQL RED/GREEN**

  integration test 从 `TTSYNC_TEST_DATABASE_URL` 连接真实数据库，调用生成的 `Health(ctx)`；停止/错误 DSN 必须产生错误，正确 DSN 必须成功。使用 `//go:build integration`，由 smoke 脚本提供 DSN。

- [ ] **Step 5: composition root GREEN**

  `app.Run` 建 pool、构造 router、启动 `http.Server`，context 取消时在 5 秒内 Shutdown 并关闭 pool；`cmd/ttsync` 仅解析配置与信号并调用 `app.Run`。

- [ ] **Step 6: 验证 Go slice**

  Run: `go test ./... -count=1`

  Expected: PASS，非 integration 测试不需要外部数据库。

### Task 3: 提供被 readiness 实际消费的 sqlc 与迁移入口

**Files:**
- Create: `db/sqlc.yaml`
- Create: `db/queries/platform/health.sql`
- Create: `db/migrations/000001_platform_schema_migrations.sql`
- Create: `internal/platform/postgres/migrate.go`, `internal/platform/postgres/migrate_integration_test.go`
- Create: `internal/platform/postgres/sqlc/*`
- Create: `cmd/migrate/main.go`
- Create: `scripts/generate-sqlc.ps1`, `scripts/test-go.ps1`

**Interfaces:**
- Consumes: `DATABASE_URL` 与嵌入式 `db/migrations/*.sql`。
- Produces: `postgres.Migrate(context.Context, *pgxpool.Pool) error`；`npm run db:generate`；`npm run test:go`。

- [ ] **Step 1: 写迁移 RED**

  真实 PostgreSQL integration test 从空 schema 调用 `Migrate` 两次：第一次建立 `schema_migrations` 并记录版本/sha256，第二次为无变化成功；篡改已应用校验和必须失败。

- [ ] **Step 2: 运行 RED**

  Run: `go test -tags=integration ./internal/platform/postgres -run Migration -count=1`

  Expected: FAIL，`postgres.Migrate` 尚不存在。

- [ ] **Step 3: 最小 GREEN migration runner**

  固定 advisory lock key；文件名严格递增；每个 migration 在一个事务中执行；账本记录版本、sha256、时间；任何失败回滚当前版本。首个 migration 只创建该 runner 自身消费的账本，不创建领域表。

- [ ] **Step 4: 生成并消费 sqlc 健康查询**

  `health.sql` 定义 `-- name: Health :one` 与 `SELECT 1::integer AS ready`；`pool.go` 必须调用生成的 Queries，而不是保留手写重复查询。

- [ ] **Step 5: 验证生成漂移**

  `scripts/generate-sqlc.ps1` 固定 `sqlc v1.31.1`，生成后 `git diff --exit-code -- internal/platform/postgres/sqlc`；`scripts/test-go.ps1` 先生成，再跑 unit 与真实 integration tests。

### Task 4: 构建 Vue 三角色空壳并嵌入 Go

**Files:**
- Create: `clients/web/package.json`, `clients/web/package-lock.json`
- Create: `clients/web/index.html`, `clients/web/tsconfig.json`, `clients/web/vite.config.ts`
- Create: `clients/web/src/main.ts`, `clients/web/src/App.vue`, `clients/web/src/style.css`
- Create: `internal/httpapi/web.go`, `internal/httpapi/web/dist/index.html`, `internal/httpapi/web/dist/assets/*`
- Create: `scripts/build-web.ps1`
- Modify: `internal/httpapi/router.go`, `internal/httpapi/router_test.go`

**Interfaces:**
- Consumes: 无领域状态；只显示主持人、参与者、观众三个角色视图入口。
- Produces: `httpapi.WebAssets() fs.FS` 与 `npm run web:typecheck`、`npm run web:build`。

- [ ] **Step 1: 写静态网页 seam RED**

  router test 请求 `/`，断言 200、`text/html`，正文包含 `TTSync`；请求未知前端路径返回同一 SPA index；不存在的 `/api/*` 返回 JSON 404 而不是 SPA。

- [ ] **Step 2: 运行 RED**

  Run: `go test ./internal/httpapi -run Web -count=1`

  Expected: FAIL，embed 与 SPA fallback 尚不存在。

- [ ] **Step 3: 最小 GREEN Vue shell**

  `App.vue` 只渲染产品标题和三个可聚焦 role tab：`主持人视图`、`参与者视图`、`观众视图`；切换只改变说明文字，不包含权限判定或领域写操作。

- [ ] **Step 4: 建立确定性 embed build**

  Vite `outDir` 指向 `internal/httpapi/web/dist`、`emptyOutDir: true`；构建后 Go embed 使用 `fs.Sub` 提供静态文件；生成目录纳入版本控制以保证全新检出可独立 `go test ./...`。

- [ ] **Step 5: 验证前端与 Go**

  Run: `npm run web:typecheck; npm run web:build; go test ./... -count=1`

  Expected: 全部 PASS。

### Task 5: 三容器 Compose、Caddy HTTPS 与真实浏览器 smoke

**Files:**
- Create: `deployments/compose.yaml`, `deployments/Caddyfile`, `deployments/Dockerfile`, `deployments/.env.example`
- Create: `.dockerignore`
- Create: `test/b01-browser-smoke.mjs`
- Modify: `scripts/smoke-b01.ps1`, `README.md`, `.gitignore`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: `TTSYNC_POSTGRES_PASSWORD`、`TTSYNC_HTTPS_PORT`；测试脚本只注入 `TEST_ONLY` 值。
- Produces: 经 `https://localhost:${TTSYNC_HTTPS_PORT}` 的唯一公开入口和可重复 Playwright smoke。

- [ ] **Step 1: 运行 deployment RED**

  Run: `npm run test:b01:structure`

  Expected: FAIL，缺 Compose/Caddy/Dockerfile 或服务合同不满足。

- [ ] **Step 2: 最小 GREEN 三容器运行面**

  多阶段 Dockerfile 先构建 Vue、再构建 Go；Compose 的 `postgres` 使用持久 volume 与 `pg_isready`，`app` 等待数据库 healthy 并运行 migrate 后启动，`caddy` 等待 app healthy、使用 `tls internal` 反代 8080；只发布 Caddy HTTPS 端口。

- [ ] **Step 3: 写真实浏览器 RED**

  Playwright 使用 Chromium、`ignoreHTTPSErrors: true`，访问 HTTPS 后断言标题和三个 role tab 可见且可点击；请求 `/health/live` 与 `/health/ready` 都为 200；浏览器 console error 数为 0。

- [ ] **Step 4: 运行并修复真实组合 smoke**

  Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-b01.ps1`

  Expected: Compose service 数量 3；迁移、真实 PostgreSQL integration test、HTTPS health、Playwright 全部 PASS；finally 删除容器和测试 volume。

- [ ] **Step 5: 文档化唯一入口**

  README 列出 prerequisites、复制 `.env.example` 的运行步骤，以及六个独立验证命令；明确证据仅覆盖 1–20 人个人测试边界，不是生产容量承诺。

### Task 6: 完整验证、双轴 review 与提交

**Files:**
- Modify: review 发现要求的最小文件集合。

**Interfaces:**
- Consumes: fixed point `a4236a763f188bb8165ae4759875d57311c4f7cc` 与 GitHub #30。
- Produces: 清洁 diff、中文提交、远端功能分支、#30 验证评论。

- [ ] **Step 1: 完整静态与单元验证**

  Run: `npm ci; npm run contracts:check; npm test; npm run db:generate; npm run web:typecheck; npm run web:build; go test ./... -count=1; git diff --check`

- [ ] **Step 2: 完整真实环境验证**

  Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-b01.ps1`

- [ ] **Step 3: 双轴代码复核**

  Standards fixed point 与 Spec fixed point 均为 `a4236a7`；Standards 检查仓库规则、模块依赖、秘密、smell baseline；Spec 逐条核对 GitHub #30 acceptance criteria。P0/P1/P2 非零时先修复并重跑相关 RED/GREEN 与完整验证。

- [ ] **Step 4: 中文提交与推送**

  Commit: `实现：#30 搭建可运行的单体纵向骨架`

  Push: `git push -u origin gofromzero/issue-30-b01`

- [ ] **Step 5: 更新 Issue**

  在 #30 评论固定点、验证命令、真实 PostgreSQL/Caddy/浏览器证据与任何明确未覆盖项；只有所有 acceptance criteria 均有证据时才关闭。
