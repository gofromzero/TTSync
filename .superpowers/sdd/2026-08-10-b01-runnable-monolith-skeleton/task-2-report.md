# Task 2 报告：Go composition root、Chi health 与真实 pgx readiness

## 状态

DONE

实现提交：`abf2980a8447e616bb153b635898788325a4af03`（`实现：建立 B-01 Go 可运行骨架`）。

## 范围

- 建立 `github.com/gofromzero/ttsync` Go module，引入 Chi v5 与 pgx/v5。
- 提供 `httpapi.New(Config) http.Handler`，只注册 liveness、readiness 与 SPA fallback。
- 提供 `postgres.Open` 与 `Health`；`Open` 在返回 pool 前执行真实 `Ping`。
- 提供 `app.Run` composition root 与 `cmd/ttsync` 入口；context 取消时以 5 秒 deadline 关闭 HTTP server，并在所有返回路径关闭数据库 pool。
- 四个领域包只以 `doc.go` 声明责任；未实现 migration/sqlc、Vue 构建或领域接口。
- `internal/httpapi/web/dist/index.html` 是仅供当前 Go embed/测试编译的最小资产 seam，后续 Task 4 负责真实 Vue 构建产物。

## RED / GREEN 证据

### Chi health

- RED：`go test ./internal/httpapi -run Health -count=1`，退出码 1；仅因 `undefined: New`、`undefined: Config` 失败。
- GREEN：同命令通过；覆盖 `/health/live` 恒为 `200 {"status":"live"}`、ready 成功为 `200 {"status":"ready"}`、ready 失败为 `503 {"status":"not_ready"}`，三者均为 `application/json`。

### 真实 PostgreSQL

- RED：`go test -tags=integration ./internal/platform/postgres -run Health -count=1`，退出码 1；仅因 `undefined: Open`、`undefined: Health` 失败。
- GREEN：Docker Desktop 恢复后启动唯一临时容器 `postgres:17-alpine`，任务 label 为 `issue-30-task2`，health 为 `healthy`，仅绑定随机 loopback 端口 `127.0.0.1:5578`。
- 命令：`go test -tags=integration ./internal/platform/postgres -run Health -count=1`。
- 结果：通过；真实 DSN 的 `Open`/`Health` 成功，非法 DSN 的 `Open` 返回错误，关闭 pool 后生成的 `Health(ctx)` 返回错误。
- 清理：`finally` 先核对任务 label，再删除精确临时容器；`docker ps -a` 过滤确认无残留。
- 环境插曲：首次验证时 Docker Desktop engine `/ping` 持续失败且自动更新安装器退出 1；经用户授权正常重启后 client/server 均为 29.4.0，真实 DB GREEN 随后完成。未把故障期间的 integration-tag 编译误报为真实 GREEN。

### app runtime

- RED：`go test ./internal/app -run Run -count=1`，退出码 1；仅因 `undefined: Run`、`undefined: Config` 失败。
- GREEN：同命令通过；覆盖正常取消 5 秒内返回并关闭数据库、监听失败关闭数据库、数据库打开错误传播。

### SPA 自审修复

- RED：`go test ./internal/httpapi -run SPA -count=1` 返回 404，证明静态 FileServer 不是 SPA fallback。
- GREEN：同命令通过；不存在的客户端路径回退到 `index.html`，随后 Chi AST 允许面测试通过。

## 最终验证

- `gofmt -d cmd internal`：无差异。
- `go test ./... -count=1`：通过。
- `go vet ./...`：通过。
- `node --test --test-name-pattern="validator|Chi adapter|PostgreSQL" test/b01-architecture.test.mjs`：7/7 目标 subtest 通过，4 项按 pattern 跳过。
- `node --test test/contracts.test.mjs`：19/19 通过。
- `npm run test:mvp-acceptance`：通过，44 个定向负例均按预期拒绝。
- `git diff --check` 与 staged `git diff --cached --check`：通过。
- `npm run test:b01:structure`：8/11 通过；3 项预期 RED 分别为后续 Task 5 的 `deployments/compose.yaml`、Task 3 的 `db/sqlc.yaml`、Task 4 的 Vue 客户端源文件缺失。本 Task 的 Chi、pgx/embed 与 secret 检查均通过。

## 自审

- Standards：0 项。提交信息为中文；Go 格式、vet、依赖与 Task1 AST 允许面均通过。
- Spec：0 项。`DATABASE_URL`、`HTTP_ADDR`、Chi health seam、真实 pgx readiness、composition root、5 秒 shutdown 与四领域空包责任均已覆盖。
- 这是实现者自审与验证，不作为独立 fixed-point clean review。

## Concerns

- 完整 B-01 结构测试仍有上述 3 个跨任务预期 RED；不得在 Task3/4/5 完成前宣称整个 B-01 骨架验收通过。
- 本 Task 不实现 migration/sqlc、Vue build/embed 替换或 Compose/Caddy；最小 HTML 资产只维持当前 Go slice 可编译。
