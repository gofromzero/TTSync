# TTSync

TTSync 当前仓库保存产品规格、OpenAPI/JSON Schema 合同及其验证脚本；尚未包含可启动的应用服务。

## 本地初始化

前置工具：

- Node.js 18.17 或更高版本（含 npm）
- Python 3（仅用于额外的架构与 capability 规格校验）
- Windows PowerShell（仅用于 PostgreSQL 模型规格校验）

从干净检出开始：

```powershell
npm ci
npm test
```

`npm test` 是日常验证入口：它校验 OpenAPI、JSON Schema、生成类型和 MVP 验收清单。仓库当前不读取环境变量、不依赖外部服务，也不需要密钥或 `.env` 文件。

## 其他检查

```powershell
npm run contracts:check
python scripts/validate_capability_state_model.py
python -m unittest discover -s tests -v
python scripts/validate-module-seams.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-f03.ps1
```

修改公开合同后，运行 `npm run contracts:generate` 更新提交到仓库的 TypeScript 类型，再用 `npm run contracts:check` 检查漂移。

## MVP 验收夹具

运行 `npm test` 以 JSON Schema 2020-12 校验 `specs/mvp-acceptance/manifest.json` 的全部结构，再校验 schema 无法表达的跨类别引用、故事 owner 唯一性和确定性白名单，并执行会断言预期规则的内置拒绝用例。该命令是 MVP 验收夹具的唯一验证入口；`ownedStories` 为每个故事指定唯一 owner，`relatedStories` 只表达跨 MVP 的合法场景关系，制品不绑定数据库主键或私有实现。
