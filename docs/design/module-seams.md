# 四个深 Module 与共享事务 seam

本规范冻结 GitHub Issue #26 要求的 `identity`、`team`、`activity`、`reporting` 四个深 Module，以及它们参与共享 PostgreSQL 工作单元的方式；其父规格是 GitHub Issue #24。本规范覆盖 MVP-01～MVP-11、故事 1～153 的模块归属和跨模块事务，但不建立 B-01 代码骨架，也不决定表名、SQL、HTTP 路由或 Go 包布局。

文中 **Module** 是规则与 Implementation 的所有者，**Interface** 是调用者必须理解的全部契约，**Seam** 是 Interface 所在位置，**Adapter** 是在 seam 上替换外部行为的实现。小型目标 Interface 把复杂规则留在深 Module 内，为调用者产生 Leverage，并把修改与验证集中为 Locality。

## 领域术语与唯一写所有者

| 领域事实 | 唯一写所有者 | 必须保持的分离 |
|---|---|---|
| 账号、密码、邮箱状态、验证／恢复令牌、登录会话 | `identity` | 账号不是成员；登录会话不是参与者会话或认领 |
| 团队、团队管理员、成员、账号绑定、邀请、游戏项目、游戏档案、记录模板、成员修订号、成员与游戏档案的长期头像引用 | `team` | 团队不是队伍；成员不是账号或人员牌 |
| 头像资产元数据、可用性、恢复期、GC 状态 | `team` | 资产领域事实不是文件字节；资产可用不等于任一资源有权引用或读取 |
| 房间、主持权、参与者会话、观众会话、人员牌、访客牌、认领、队伍、容量、对局记录、房间修订号、房间快照、对局快照、房间内头像引用 | `activity` | 房间快照不是对局快照；参与者会话不是登录会话；认领不是身份或分队 |
| 历史查询、基础统计、六表 CSV 导出的只读模型 | `reporting` | 读模型不成为任何领域事实的写入口 |

一个事实只能由表中一个 Module 改变。其他 Module 可以在同一工作单元中请求所有者校验或执行目标型命令，但不能复制规则、直接改所有者状态或以缓存的角色事实代替重新鉴权。

## 外部 Interface

每个 Module 只有一个外部 Interface；下列“目标”是能力族而不是表级方法清单。Interface 的测试与生产调用者跨同一个 seam，不能越过它拼接内部表状态。

### `identity` Module

| 契约 | 冻结内容 |
|---|---|
| 目标 | 注册与验证账号、认证、执行令牌／邮箱／密码／会话目标命令、解析当前登录会话 |
| 输入 | 对应目标命令、未认证请求事实或当前登录会话凭据、调用者提供的工作单元、请求时间 |
| 结果 | `AccountID`、当前邮箱验证状态、会话事实或不暴露账号存在性的通用受理结果；不返回团队或房间角色 |
| 稳定失败 | `invalid_credentials`、`account_unverified`、`token_invalid_or_expired`、`session_invalid_or_expired`、`revision_conflict`、`rate_limited` |
| 重新鉴权 | 每次受保护调用重新解析登录会话及账号验证状态；不得从登录会话缓存团队或房间权限 |
| 事务参与 | 在调用者传入的 PostgreSQL 工作单元中锁定并改变身份事实；只报告结果，不决定共享提交 |

### `team` Module

| 契约 | 冻结内容 |
|---|---|
| 目标 | 创建团队、接受邀请、改变成员生命周期／角色、离开团队、确保游戏档案、改变项目／档案／模板／长期头像引用；登记头像资产元数据、推进可用性、恢复期与 GC 状态；判断团队能力与主持资格 |
| 输入 | 目标型命令、`AccountID` 或明确的未认证身份事实、目标聚合的 `expectedRevision`、调用者提供的工作单元、请求时间 |
| 结果 | 稳定团队／成员／档案标识、实际修订号、是否改变及最小资格事实；不暴露内部行结构 |
| 稳定失败 | `authentication_required`、`account_unverified`、`team_forbidden`、`invitation_invalid_or_expired`、`member_ineligible`、`last_administrator`、`active_hosting_conflict`、`binding_conflict`、`profile_conflict`、`avatar_state_conflict`、`revision_conflict` |
| 重新鉴权 | 每个目标命令都在当前工作单元通过 `identity` Interface 重新取得账号验证事实，再由 `team` 自行校验其拥有的绑定、成员启停、管理员和目标资源状态；跨房间规则同时请求 `activity` Interface 的当前事实 |
| 事务参与 | 在调用者传入的 PostgreSQL 工作单元中执行条件写入、唯一性与提交后不变量检查；不持有提交权 |

### `activity` Module

| 契约 | 冻结内容 |
|---|---|
| 目标 | 执行类型化房间命令、读取角色化完整房间快照、判断成员是否仍主持开放房间；命令内部覆盖主持、访问、人员牌、认领、队伍与对局 |
| 输入 | `roomId`、`commandId`、操作者凭据事实、`expectedRevision`、类型化 payload、调用者提供的工作单元；快照读取带当前访问凭据 |
| 结果 | 命令标识、实际房间修订号、`changed` 和必要目标结果，或同一修订号下的角色化完整房间快照与服务端计算 capability |
| 稳定失败 | `authentication_required`、`room_not_visible`、`room_forbidden`、`host_ineligible`、`room_state_conflict`、`revision_conflict`、`command_reuse_conflict`、`claim_conflict`、`capacity_conflict` |
| 重新鉴权 | 每条写命令和每次快照读取都通过 `identity` Interface 解析当前账号凭据，通过 `team` Interface 取得当前成员、管理员、项目和主持资格事实；参与者会话与观众会话由 `activity` 自行解析，HTTP 侧仅传递原始凭据与目标输入 |
| 事务参与 | 写命令在调用者传入的 PostgreSQL 工作单元中完成鉴权、规则、状态、一次 revision 递增和事务内失效通知；不提前或单独提交 |

#### MVP-08 命令幂等与并发判定契约

相同 `commandId`、操作者和请求指纹组成幂等键；请求指纹包含类型化 payload 与 `expectedRevision`。只有已提交成功命令的 `commandId`、操作者和请求指纹可以命中幂等重放，并返回首次成功结果，包括首次成功的 `changed`、revision 与目标结果，不重新执行命令。

同一 `commandId` 换操作者时稳定返回 `command_reuse_conflict`；同一 `commandId` 换请求指纹时同样稳定返回 `command_reuse_conflict`，不得把该 ID 当作新命令执行。

旧 `expectedRevision` 的拒绝优先于语义 no-op，并稳定返回 `revision_conflict`。基于当前 revision 且通过鉴权与领域规则的合法 no-op 返回 `changed: false`；`changed: false` 不递增 revision 且不登记 `NOTIFY`。

完整判定顺序为：解析 `commandId` → 核对操作者并拒绝复用冲突 → 核对请求指纹并拒绝复用冲突 → 命中相同幂等键时返回首次已提交成功结果 → 校验 `expectedRevision` → 重新鉴权身份与权限 → 校验领域规则 → 判断语义是否改变 → 写入状态 → 递增 revision → 登记 `NOTIFY` → 记录命令结果 → 由应用编排统一提交。

仅 `changed: true` 执行写入状态、递增 revision 与登记 `NOTIFY`；合法 no-op 仍记录其首次命令结果。任何失败均整体回滚，命令结果与占位均不持久化；失败后的后续重试重新走鉴权、版本与领域规则，没有已提交成功的 ledger 时不以旧失败制造 `command_reuse_conflict`。该顺序是 Interface 契约，不由 Adapter 或调用者改排。

### `reporting` Module

| 契约 | 冻结内容 |
|---|---|
| 目标 | 查询历史、查询基础统计、流式生成同一一致读取点的六张 CSV 长表 |
| 输入 | 当前登录会话、团队／项目范围、时间与状态筛选、调用者提供的只读工作单元 |
| 结果 | 按当前权限过滤的历史／统计读模型，或即时下载流；不返回可用于改变领域事实的句柄 |
| 稳定失败 | `authentication_required`、`account_unverified`、`team_forbidden`、`export_forbidden`、`invalid_filter`、`read_snapshot_failed` |
| 重新鉴权 | 每次查询通过 `identity` Interface 取得当前账号验证事实，再通过 `team` Interface 校验成员绑定／启停；每次导出还由 `team` 重新校验当前有效管理员资格 |
| 事务参与 | 只加入调用者建立的一致只读 PostgreSQL 工作单元；只消费 `identity`、`team`、`activity` 已提交事实 |

## 共享 PostgreSQL 工作单元

应用编排是跨 Module 工作单元的唯一发起者和完成者：建立工作单元，按 `identity → team → activity` 的统一所有权顺序调用 Interface，最后只执行一次提交；任一步稳定失败或 Adapter 故障都只执行一次统一回滚。领域 Module 可以登记事务内 `NOTIFY`，但通知仅在同一提交成功后可见；Module 不创建嵌套提交点，也不把部分结果暴露成成功。

单一所有者写用例仍由应用编排提供工作单元，以保持同一调用形状。`reporting` 查询由应用编排发起一致只读工作单元。锁的具体表、SQL 与超时属于 PostgreSQL Adapter 的 Implementation；领域 Interface 只承诺稳定失败和原子结果。该难以逆转且非显然的取舍记录在 [ADR-0001](../adr/0001-shared-postgresql-work-unit.md)。

## 跨 Module 场景

### 邀请接受

**事务发起者**：应用编排在已解析登录会话后建立共享工作单元。

**规则所有者**：`identity` 重新确认账号已验证并提供规范化邮箱事实；`team` 独占邀请有效性、邮箱匹配、成员启用／未绑定、同团队账号绑定唯一性和并发最多一个成功。

**稳定失败**：`session_invalid_or_expired`、`account_unverified`、`invitation_invalid_or_expired`、`member_ineligible`、`binding_conflict`。

**统一回滚**：任何检查、条件写入或审计失败都不接受邀请、不建立绑定、不改变成员修订号；并发请求最多一个提交。

### 主持资格保护

**事务发起者**：应用编排为停用、解绑、团队离开或管理员撤销目标命令建立共享工作单元。

**规则所有者**：`team` 独占成员生命周期、绑定和最后管理员规则；`activity` 独占“该成员仍主持开放房间”的当前事实。两者在统一所有权顺序下锁定并重检提交后状态。

**稳定失败**：`team_forbidden`、`revision_conflict`、`last_administrator`、`active_hosting_conflict`。

**统一回滚**：失败时成员启停、绑定、管理员角色、主持权和审计均保持原状；系统不自动转移主持权。

### 管理员接管

**事务发起者**：应用编排为显式“接管房间”命令建立共享工作单元。

**规则所有者**：`team` 重新确认操作者是当前有效管理员且目标项目资格有效；`activity` 独占开放房间唯一主持人不变量与主持权切换。

**稳定失败**：`session_invalid_or_expired`、`team_forbidden`、`room_not_visible`、`host_ineligible`、`revision_conflict`。

**统一回滚**：任一步失败时旧主持人保持不变，房间 revision、审计和失效通知均不产生；查看权限本身不隐式接管。

### 访客归属

**事务发起者**：应用编排为主持人的“关联已有成员”或“保存为新成员并归属”目标命令建立共享工作单元。

**规则所有者**：`team` 独占成员、游戏档案及其唯一性；`activity` 独占访客牌和稳定历史归属，只改变归属标识，不重写人员显示或对局快照。

**稳定失败**：`room_forbidden`、`member_ineligible`、`profile_conflict`、`revision_conflict`。

**统一回滚**：建成员／档案、访客归属、审计和房间 revision 任一失败则全部撤销；既有房间快照可在重读后反映当前归属，而冻结的对局快照字节与显示事实不变。

### 头像引用切换

**事务发起者**：应用编排先让 files Adapter 完成不可变资产写入，再为数据库引用切换建立工作单元；成员默认头像和游戏档案覆盖调用 `team`，房间人员牌头像调用 `activity`。

**规则所有者**：`team` 独占头像资产元数据、可用性、恢复期和 GC 状态；`team` 或 `activity` 作为目标引用的所有者重新鉴权并独占对应引用与修订号规则。`team` 只能通过 `activity` Interface 取得房间引用和恢复期事实，不能越过 seam 查询其状态；files Adapter 只处理字节写入、读取、完整性校验与幂等删除，不知道资产元数据、可用性、GC、成员、主持人或认领角色。对局快照引用创建后不可切换。

**稳定失败**：`avatar_invalid`、`avatar_storage_failed`、`team_forbidden`、`room_forbidden`、`claim_conflict`、`revision_conflict`、`avatar_integrity_failed`。

**统一回滚**：文件失败时不开始数据库切换；数据库失败时旧引用和修订号不变，新资产成为可延迟对账的孤儿；不得声称 PostgreSQL 与文件共同原子提交。

## Adapter seam

- `Chi` Adapter：只解析 HTTP、Cookie、CSRF、房间访问凭据和 DTO，并把稳定结果映射为 HTTP 状态与 Problem Details。
- `PostgreSQL` Adapter：提供工作单元、锁、条件写、唯一约束、sqlc 查询、一致读取点和事务内通知；数据库是真实事务证据，不以 mock 替代。
- `files` Adapter：只提供不可变头像文件字节的写入、读取、完整性验证与幂等删除；不写资产元数据、可用性、恢复期或 GC 状态，领域资源上下文授权先于资产解析。
- `mail` Adapter：发送领域 Module 已决定内容与收件范围的邮件，并暴露可故障注入的投递结果。
- `clock` Adapter：提供请求／事务使用的当前时间，令牌、邀请、会话和宽限期规则仍归对应领域 Module。

Adapter 不拥有领域角色。真实生产 Adapter 与测试替身使这些 seam 成立；文件与 PostgreSQL 的跨存储失败必须按上文补偿边界验证。

## MVP、故事与 Module／seam 追踪

下表是父规格验收矩阵在本票的机器可校验归属。故事可因跨 Module 原子场景出现在多个 MVP 的父规格范围中，但每一行只有一组明确的规则所有者与调用 seam；表中 11 行的故事并集必须恰好覆盖 1–153。

| MVP | 故事 | Module | seam |
|---|---:|---|---|
| MVP-01 | 1–21 | identity、team | `identity`／`team` Interface + 共享工作单元 seam |
| MVP-02 | 7–19、22–30 | identity、team | `identity`／`team` Interface + 共享工作单元 seam |
| MVP-03 | 45–62 | team | `team` Interface seam |
| MVP-04 | 76–92 | identity、team、activity | `identity`／`team`／`activity` Interface + 共享工作单元 seam |
| MVP-05 | 93–107 | activity | `activity` Interface seam |
| MVP-06 | 108–120 | activity | `activity` Interface seam |
| MVP-07 | 31–44 | identity、team、activity | `identity`／`team`／`activity` Interface + 共享工作单元 seam |
| MVP-08 | 121–128 | identity、team、activity | `identity`／`team`／`activity` Interface + 共享工作单元 seam |
| MVP-09 | 129–142 | activity | `activity` 角色化快照 Interface + SSE／Chi Adapter seam + 真实浏览器／Caddy／真实 PostgreSQL seam |
| MVP-10 | 143–153 | identity、team、reporting | `identity`／`team`／`reporting` Interface + 一致只读工作单元 seam + 浏览器下载 seam |
| MVP-11 | 63–75 | team、activity | `team`／`activity` Interface + files Adapter／真实 PostgreSQL／浏览器／恢复 seam |

## RED／GREEN 验证记录

命令均从仓库根目录执行：`python scripts/validate-module-seams.py`。

- 第一轮 RED（补入五项自审约束后）：exit 1，报告 MVP 映射缺失、故事 1–153 未完整映射、头像资产所有权与 Interface 目标缺失、files Adapter 责任过宽、team 未经 identity Interface 重新鉴权、`binding_conflict`／`profile_conflict` 未进入稳定失败、`观众会话` 未定义。
- 第一轮 GREEN：exit 0，输出“模块 seam 规范校验通过：术语、交叉引用、必需场景与禁用模式均满足。”
- 第二轮 RED（把父规格逐项编码为准确 oracle 后）：exit 1，报告 MVP-02 多纳故事 20–21，MVP-09 缺真实浏览器／Caddy／真实 PostgreSQL，MVP-10 缺浏览器下载，MVP-11 缺 files Adapter／真实 PostgreSQL／浏览器／恢复 seam。
- 第二轮 GREEN：exit 0，输出“模块 seam 规范校验通过：术语、交叉引用、必需场景与禁用模式均满足。”

## 明确禁止

- 不按表暴露 `Create/Get/List/Update/Delete` 方法，也不让调用者组合内部行来重建领域命令。
- Chi Adapter 不接收或缓存“已经是管理员／主持人”的布尔结论；它只传凭据与目标输入。
- `reporting` 只产生读模型与下载流，不充当命令入口。
- 任一领域 Module 都不能结束调用者提供的共享工作单元；统一提交与回滚只属于应用编排。
- 不由跨 Module 事务顺便建立 B-01 产品代码、数据库表或通用框架。

## 验证 seam

本票的机器校验命令是 `python scripts/validate-module-seams.py`，它检查四个 Module、Interface 六项契约、MVP-01..11 与故事 1..153 的集合映射、领域术语交叉引用、五个跨 Module 场景、Adapter 分类、父子票引用和禁用模式。后续产品票仍须在公开 HTTP/SSE、真实 PostgreSQL、真实文件与浏览器 seam 以 RED→GREEN 证明行为；本规范通过不等于产品实现通过。
