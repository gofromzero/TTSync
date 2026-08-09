# TTSync

## 规格验证

运行 `npm test` 以 JSON Schema 2020-12 校验 `specs/mvp-acceptance/manifest.json` 的全部结构，再校验 schema 无法表达的跨类别引用、故事 owner 唯一性和确定性白名单，并执行会断言预期规则的内置拒绝用例。该命令是 MVP 验收夹具的唯一验证入口；`ownedStories` 为每个故事指定唯一 owner，`relatedStories` 只表达跨 MVP 的合法场景关系，制品不绑定数据库主键或私有实现。
