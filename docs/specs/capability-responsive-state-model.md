# F-04 三角色 capability 与响应式状态模型

本规格冻结 GitHub #28 的前置产品合同，不实现 Vue 页面或 B-01 骨架。机器可读权威制品是 [`contracts/capability-state-model.json`](../../contracts/capability-state-model.json)，结构合同是同目录的 `capability-state-model.schema.json`；`python scripts/validate_capability_state_model.py` 会实际执行该 schema，再检查生命周期及故事交叉引用的语义完整性。

## 1. 权限边界

- 服务端角色化房间快照是 capability 和字段可见性的唯一权威。客户端只能按 capability 显示、启用或禁用控件，不得用 `role === "host"`、管理员标记、是否本人或认领状态复制权限规则。
- `teamAdminViewer` 可以查看团队内房间，但房间密码、人员牌、分队、记录、凭据和房间状态写入均为 deny。`room.host.takeover` 是管理员成为主持人的角色转换命令，而不是已是主持人的写操作前置；接管成功并重新读取快照后，主持写直接由新快照中的 `currentHost` 决策与生命周期规则授权。
- 删除/恢复属于团队管理员生命周期能力，不伪装成主持写入；本人长期资料、管理员长期资料、主持范围档案字段、当前认领牌字段分别使用不同服务端 capability。
- 建房与主持权交接也是独立服务端能力：`room.create` 覆盖启用成员为启用项目建房及匿名拒绝，`room.host.transfer` 只允许当前主持人把主持权转给合格成员。头像读取由 `avatar.asset.read` 在成员、房间、人员牌或快照资源上下文先授权，再解析稳定资产标识。
- 密码、参与者凭据、观众令牌、登录会话标识和认领秘密永不进入房间快照。字段不存在就是不可见，客户端不得从其他字段推导或补回。

### 生命周期覆盖

`open` 才按快照开放房间写入；`ended` 保持可见但只读，是否可重开由服务端单独授予；`deleted` 对普通访问者是 404 不可见终态；`credentialInvalid` 是 401 终态。成员、项目或档案停用是覆盖性限制，不批量改写人员牌、认领、队伍、对局或历史，也不把独立匿名访问会话当作登录权限的附属品。`profileDisabled` 对本人、管理员和主持人的全部游戏档案写 capability 都是 deny。

项目停用后，“新增对局记录”和“维护既有记录”不是同一能力：`room.record.create` 被拒绝，`room.record.maintain` 仍可由当前主持人确认、更正、作废或恢复已有记录。两者保持独立稳定标识，客户端不得以一个合并写能力重新推导。

MVP-10 的服务端权威只读能力分为项目历史 `reporting.history.read`、基础统计 `reporting.statistics.read`、主持记录管理摘要 `reporting.roomRecordSummary.read` 和管理员六表导出 `reporting.export.csv`。历史默认最近 90 天并支持父规格限定的筛选；统计只取已确认记录的最新有效版本且不生成排行榜；CSV 沿用筛选、来自同一一致读取点、即时下载且不落为持久资产。故事 143–153 在 `storyTrace` 中逐故事独立映射到上述能力，避免只列 MVP 编号而没有可执行语义。

## 2. 三角色与响应式布局

四个固定验收宽度为 desktop、320px、390px、520px。桌面主持人使用设置、待分配区和队伍画布组成的调度台；桌面参与者/观众使用分队矩阵。窄屏主持人使用纵向队伍栈，参与者使用分页矩阵并把本人入口置前，观众使用只读总览聚焦布局。

每个角色和宽度都必须呈现同一组状态，而不是靠某一布局隐藏：`loading`、`empty`、`connected`、`recovering`、`polling`、`unreadable`、`conflict`、`ended`、`deleted`、`credentialInvalid`。具体控件、文字状态和播报在机器制品 `stateDefinitions` 中固定。

## 3. 实时收敛状态机

SSE/NOTIFY 只是 `{roomId, revision}` 失效提示，不是事实或可靠历史。客户端保存 `appliedRevision` 与 `targetRevision`：小于等于已应用版本的通知忽略，更大版本只提升目标并触发单飞快照读取；版本落后的晚到快照丢弃，并继续追到目标版本。

断线立即进入 `recovering`、全量读取，随后每 15 秒进入轮询降级。SSE 再次打开不能立刻停止轮询，必须先完成一次权威快照校准。降级写入在发送命令前读取最新快照；只有最新快照不可读才禁用。

401 进入凭据失效终态，404 进入不可见/删除终态，两者都停止 SSE 与轮询。409 显示“操作未应用，房间已更新”，刷新快照但绝不自动重放旧意图；用户必须在新状态上重新决定。

## 4. 等价操作与无障碍

拖拽只可作为桌面增强。认领、释放、移动、撤回、容量调整与冲突处理的权威路径均为可聚焦按钮/输入组合，支持 Tab、Enter/Space 和必要的方向键，触控目标至少 44×44 CSS px。

快照替换优先以稳定实体 ID 恢复滚动、展开状态和焦点；目标消失时聚焦最近稳定容器并播报原因。连接、满员、超员、只读、失败、选中和冲突都有可见文字/图标及状态区播报，不以颜色作为唯一表达。

## 5. 验收与变更规则

运行：

```powershell
python scripts/validate_capability_state_model.py
python -m unittest discover -s tests -v
```

验证器先执行公开 schema，检查必填字段、字段可见性类型、禁止额外字段及生命周期结构；随后检查所有 capability 对六种访问上下文都有 allow/deny、控件、字段、故事和合法生命周期引用。任何 `requiresCapability` 都必须指向现有能力、不得形成循环，并且原能力的每个 allowed actor 都必须能沿整条依赖链获得 allow；因此 takeover 不可能再成为 currentHost 写操作的不可满足依赖。`storyTrace` 中每个故事必须实际出现在至少一个被引用的 `capability.stories`，且 `visibleFields`、`lifecycleRules` 必须分别等于引用能力的字段与生命周期精确并集；143–153 还必须逐故事恰好追踪一次并命中固定 reporting 语义。`profileDisabled` 自动约束所有现在及未来的 `gameProfile.*` 写能力。验证器还强制记录新增与既有记录维护能力同时存在并保持项目停用语义分离，验证三角色覆盖四种宽度与十种页面状态、关键实时迁移齐全，以及六个核心操作具有键盘、44px、焦点恢复和非纯颜色播报。未来若服务端合同改变 capability 名、字段或状态迁移，必须先更新此公开制品和验证，再实现客户端消费；不得在客户端另建一份权限矩阵。
