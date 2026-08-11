# TTSync

## 规格验证

运行 `npm test` 以 JSON Schema 2020-12 校验 `specs/mvp-acceptance/manifest.json` 的全部结构，再校验 schema 无法表达的跨类别引用、故事 owner 唯一性和确定性白名单，并执行会断言预期规则的内置拒绝用例。该命令是 MVP 验收夹具的唯一验证入口；`ownedStories` 为每个故事指定唯一 owner，`relatedStories` 只表达跨 MVP 的合法场景关系，制品不绑定数据库主键或私有实现。

## 个人测试部署

此组合环境只面向 1–20 人的个人休闲测试，不是生产容量、可用性、备份或恢复承诺。需要 Docker Desktop、Node.js `^20.19.0 || >=22.12.0` 和 PowerShell；该范围与 `clients/web/package.json` 的 `engines.node` 一致。首次真实浏览器验收前，先按锁文件安装依赖，再仅使用已安装的 Playwright 下载 Chromium：

```powershell
npm ci
npx --no-install playwright install chromium
```

```powershell
Copy-Item deployments/.env.example .env
docker compose --env-file .env -f deployments/compose.yaml up --build --wait
```

页面入口为 `https://localhost:8443`；Caddy 使用本地 CA，浏览器手动访问时需信任该开发证书。停止并删除测试数据：

```powershell
docker compose --env-file .env -f deployments/compose.yaml down -v --remove-orphans
```

可独立重复的验证入口：`npm run test:contracts`、`npm run contracts:check`、`npm run test:mvp-acceptance`、`npm run test:b01:structure`、`npm run db:generate`、`npm run db:migrate:test`、`npm run web:typecheck`、`npm run web:build`、`npm run test:go`、`npm run smoke:b01`。其中 `npm run test:go` 组合执行 sqlc 漂移检查、Go 单元测试与真实 PostgreSQL integration test；`npm run smoke:b01` 组合执行三容器构建启动、迁移、真实数据库停启 readiness、HTTPS 与 Playwright 浏览器验收并清理测试资源。
