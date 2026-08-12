# ID-01 注册与邮箱验证实现计划

> **For agentic workers:** 按 TDD 逐个切片实施；每个切片中文提交并独立复核。

**目标：** 经真实 PostgreSQL、Caddy HTTPS 和测试邮件完成注册、重发与一次性邮箱验证，且不暴露账号是否存在。

**真相来源：** GitHub #31、`contracts/v1/openapi.yaml`、`docs/architecture/postgresql-model-v1.md`。本文件只记录实施顺序，不复制完整规格，也不新建 OpenSpec。

## 最小设计

- `identity.Module` 是具体类型，不增加单实现 Go interface、repository 或通用 UoW。
- Module 直接使用 `pgxpool`；单一所有者命令自行开启并完成事务，唯一性、令牌和审计规则留在 Module 内；HTTP 与 app 组装层不持有业务事务。
- 标准库负责邮箱 trim/lower、Unicode 可打印检查、CSPRNG、SHA-256、SMTP 和测试 outbox；密码哈希复用已安装的 `x/crypto/argon2`。
- 邮件以一个函数参数作为内部 seam：生产用强制验证证书的 STARTTLS（TLS 1.2+），开发/烟测显式使用容器 outbox；不增加服务或公开 outbox endpoint。Register/Resend 投递失败在已提交状态上追加安全事件，并只返回统一可重试依赖错误。
- 单机限速用进程内 mutex + 有界 map；注册/重发先检查 IP 再分配目标桶，验证提交只按 IP 30/hour；`# ponytail:` 注明多实例时再换共享存储。
- Vue 继续使用现有 `App.vue`，不增加路由、状态库或表单依赖。

## 固定规则

- 邮箱：trim 后保留展示写法，整体小写作为 PostgreSQL 唯一键。
- 密码：原样处理；15–128 个可打印 Unicode code point；拒绝包内固定泄露密码集合。
- 令牌：`crypto/rand` 生成，24 小时，按用途和 generation 单次消费；数据库只存 SHA-256。
- 未触发限速时，注册与重发始终返回 `{accepted:true}`；所有目标/IP 限速统一为不暴露桶类型的 429；无效、过期、重放、旧代和用途错误统一为同一个 422。
- anonymous CSRF：首屏设置 Secure/SameSite 同源 cookie，客户端回送 `X-CSRF-Token`；不增加 token API。
- 注册事务先提交 pending 账号、令牌和安全事件，再投递邮件；投递失败不变成 verified，可由 resend 恢复。
- 不实现登录、会话、密码恢复、邮箱变更、邀请解析、团队、SSE、Redis 或 CAPTCHA。

## Slice 1 — 公开合同（完成：`fab0cf7`）

- [x] RED：注册响应泄露 `accountId`；CSRF 来源未说明；验证失败语义不统一。
- [x] GREEN：注册/重发通用受理；CSRF cookie→header；五类无效令牌统一 422；生成类型无漂移。

## Slice 2 — identity + PostgreSQL

**修改：** `db/migrations/000002_identity_registration.sql`、`db/queries/identity/`、`db/sqlc.yaml`、`internal/identity/`。

- [x] RED（纯 Go）：邮箱展示/唯一键、Unicode 密码边界、泄露密码、令牌摘要/期限、限速桶。
- [x] RED（真实 PostgreSQL）：并发同邮箱只留一账号；重发新代废旧代；过期/重放/用途错/并发消费不改变状态；安全事件不含密码、完整令牌或摘要。
- [x] GREEN：三张表足够——`accounts`、`verification_tokens`、`identity_security_events`；增加一组 identity sqlc 查询和具体 `identity.Module`。
- [x] 验证：定向 unit/integration、`npm run db:generate`、`npm run test:go`；中文提交。

## Slice 3 — HTTP + CSRF + 邮件

**修改：** `internal/httpapi/`、`internal/app/`、`cmd/ttsync/`；只在需要时新增 `internal/platform/mail/`。

- [x] RED：三个冻结 endpoint 的严格 JSON、CSRF、通用响应、统一 Problem Details、限速及日志秘密缺失。
- [x] RED：SMTP 失败后账号仍 pending 且 resend 可恢复；测试 outbox 文件权限为 0600。
- [x] GREEN：Chi 只解析/映射；app 组装具体 Module；SMTP/outbox 都通过同一个发送函数调用。
- [x] 验证：HTTP/app 定向测试、Go 全包；中文提交。

## Slice 4 — Vue + 真实浏览器

**修改：** 现有 Vue 三文件、一个 `test/id01-browser-smoke.mjs`，以及现有 Compose smoke 的最小复用点。

- [x] RED：真实浏览器注册 → 从容器测试 outbox 读取链接 → 验证；重复注册反馈相同；令牌重放失败。
- [x] GREEN：在 `App.vue` 加原生表单；测试模式只通过 `docker compose exec` 读取 outbox，不公开 HTTP endpoint；仍恰好三个容器。
- [x] 验证：contracts/MVP/structure/sqlc/web/Go/vet、真实 PostgreSQL、Caddy/Chromium、秘密扫描、资源零残留。
- [x] Standards 与 Spec 最终复核；修完全部 finding 后中文提交。
- [x] 推送分支并关闭 #31。
