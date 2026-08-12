# PostgreSQL 持久化模型 v1

状态：冻结，供 GitHub Issue #27 后续纵向票消费。版本：`v1`。依据：父规格 #24、`CONTEXT.md`、两份 `docs/research` 事实文档。

本文只固定逻辑模型、事务不变量和持久化 seam，不提供 migration、`sqlc.yaml`、SQL 查询、Go B-01 骨架或可运行数据库。后续纵向票只实现其用例实际消费的最小切片；禁止为了“对齐本文”预建空表、占位查询或未被调用的抽象。

## 聚合、稳定标识与修订号

所有 ID 都是服务端生成、不可复用、与显示名无关的稳定 UUID。外键只引用稳定 ID；名称、邮箱、昵称、文件路径、房间密码和分享令牌都不是身份。时间均为带时区时间，删除业务对象优先用显式生命周期，不能复用旧 ID。

| 聚合 / 实体 | 稳定标识 | 所属聚合 | 生命周期 | 并发版本 |
|---|---|---|---|---|
| 账号 | `account_id` | identity | pending_verification → active；凭据撤销不删除身份 | 认证凭据由令牌代次和会话撤销时间保护，不借用业务 revision |
| 登录会话 | `session_id` | identity | active → revoked / expired | 独立撤销，无聚合 revision |
| 一次性令牌 | `token_id` | identity | active → consumed / revoked / expired | 同账号同用途的 `generation` 单调递增 |
| 团队 | `team_id` | team | active | 团队本身不承载成员并发版本 |
| 成员 | `member_id` | team | enabled ↔ disabled | `member_revision`，初值 1，每次资料、状态、绑定或角色真实改变 +1 |
| 账号绑定 | `member_id` + `account_id` | 成员 | bound / unbound | 由目标成员的 `member_revision` 保护 |
| 管理员角色 | `member_id` | 成员 | granted / revoked | 由目标成员的 `member_revision` 保护；最后管理员另加团队锁 |
| 团队邀请 | `invitation_id` | team | pending → accepted / revoked / expired | 不复用成员 revision；重发创建新 ID 并使旧邀请失效 |
| 游戏项目 | `game_project_id` | team | enabled ↔ disabled | `project_revision`，初值 1，名称、状态、当前模板真实改变 +1 |
| 游戏档案 | `game_profile_id` | team | enabled ↔ disabled | `profile_revision`，初值 1，资料、状态、头像覆盖真实改变 +1 |
| 记录模板 | `template_id` | 游戏项目 | immutable published version | `template_version` 从 1 递增；已发布版本不就地修改 |
| 记录字段 | `field_id` | 记录模板版本族 | active / removed | 稳定字段 ID；改名保 ID，删除后重建用新 ID |
| 房间 | `room_id` | activity | open ↔ ended；open/ended → deleted；删除满 30 天后永久清理 | `room_revision`，初值 1，任一房间持久业务状态真实改变 +1 |
| 房间访问会话 | `room_session_id` | activity | active → revoked / expired | 凭据轮换或终态撤销，不作为房间 revision 的替代品 |
| 人员牌 | `card_id` | 房间 | active | 随房间聚合，以 `room_revision` 并发控制 |
| 认领 | `claim_id` | 房间 | active → released / revoked | 随房间聚合，以 `room_revision` 并发控制 |
| 临时队伍 | `room_team_id` | 房间 | active | 随房间聚合，以 `room_revision` 并发控制 |
| 对局记录 | `match_id` | 房间 | draft / confirmed / voided | 房间命令由 `room_revision` 控制；更正是修订动作，以不可变 `match_version` 链记录，不是生命周期状态 |
| 对局快照 | `match_snapshot_id` | 对局记录版本 | immutable | 无可变 revision；冻结模板、队伍、人员和头像引用 |
| 头像资产 | `avatar_asset_id` | 文件能力 | ready → gc_pending → delete_pending → deleted；完整性故障另记 | 状态转换以资产行锁保护，不借用成员、档案或房间 revision |
| 房间命令结果 | (`room_id`, `command_id`) | 房间 | executing → completed | 保存首次结果与指纹；不形成第二条业务版本线 |
| 审计记录 | `audit_id` | 各模块 | immutable | 无 revision，只追加 |

四个条件写 revision 明确归属且不可互借：成员命令只接收 `expectedMemberRevision`，由 team 模块用 `member_id + member_revision` 条件写；项目命令只接收 `expectedProjectRevision`，由 team 模块用 `game_project_id + project_revision` 条件写；游戏档案命令只接收 `expectedProfileRevision`，由 team 模块用 `game_profile_id + profile_revision` 条件写；房间命令只接收 `expectedRoomRevision`，由 activity 模块用 `room_id + room_revision` 条件写。跨聚合命令必须声明其读取后参与决定或将被改变的每一类 expected revision，在统一锁内逐一比较，不能拿一种 revision 证明另一聚合仍然有效。

拒绝边界固定为：旧 `member_revision` 拒绝成员资料、状态、绑定和角色写；旧 `project_revision` 拒绝项目资料、状态和当前模板写；旧 `profile_revision` 拒绝档案资料、状态与头像覆盖写；旧 `room_revision` 拒绝房间、牌、认领、队伍、对局和访问凭据写。revision 字段缺失、归属 ID 不匹配或拿其他聚合 revision 代替，均在不产生业务变化、审计成功事实或通知的情况下返回稳定冲突；只有该命令实际改变的聚合 revision 各自递增一次。

快照不是聚合当前状态的可变副本：人员牌冻结建牌时显示名和头像资产引用，对局快照再冻结当局模板、字段、队伍、人员牌显示信息及头像引用；后续长期资料变化不得回写。

## 生命周期状态机

允许的状态转换如下；未列出的转换一律由领域校验拒绝。

| 对象 | 允许转换 | 条件和结果 |
|---|---|---|
| 成员 | enabled → disabled | 非最后有效管理员、不是开放房间合格主持人；保留绑定，撤销管理员与待接受邀请，`member_revision + 1` |
| 成员 | disabled → enabled | 保持现有绑定和档案状态，不恢复管理员，`member_revision + 1` |
| 账号绑定 | unbound → bound | 成员启用且未绑定、账号已验证且在团队未绑定其他成员，`member_revision + 1` |
| 账号绑定 | bound → unbound | 非开放房间主持人；必要时撤管理员但不得留下零管理员，`member_revision + 1` |
| 团队离开 | bound+enabled → unbound+disabled | 同一事务停用、解绑、撤管理员；同样保护最后管理员与主持权，`member_revision + 1`（一次命令只增一次） |
| 邀请 | pending → accepted | 未过期/撤销、邮箱匹配、目标成员和账号仍唯一；绑定与结果原子完成 |
| 邀请 | pending → revoked / expired | 显式撤销，或读取/使用时按 `expires_at <= now()` 判定终态 |
| 游戏项目 | enabled ↔ disabled | 停用前无开放房间；停用阻止新活动但保留历史，`project_revision + 1` |
| 游戏档案 | enabled ↔ disabled | 项目和成员规则允许；真实变化时 `profile_revision + 1` |
| 房间 | open → ended | 结束后拒绝新业务写；`room_revision + 1` |
| 房间 | ended → open | 仅合格主持人或已接管的团队管理员重新开放；重新校验项目、主持人与访问凭据资格，`room_revision + 1` |
| 房间 | open/ended → deleted | 仅团队管理员删除；记录删除前状态和 `deleted_at`，进入 30 天恢复期，撤销房间访问会话且拒绝业务写，`room_revision + 1` |
| 房间 | deleted → open/ended | 仅团队管理员可在 30 天恢复期内恢复到删除前状态；恢复 `open` 时重新校验项目与主持人资格，稳定 `room_id` 不变，`room_revision + 1` |
| 房间永久清理 | deleted → purged | `deleted_at + 30 天 <= now()` 后由维护任务清理房间业务明细并保留最小审计墓碑；永久清理后不可恢复，旧 `room_id` 不复用 |
| 对局 | draft → confirmed | 对局状态仅为 draft / confirmed / voided；确认冻结完整对局快照，随房间事务递增一次 `room_revision` |
| 对局更正 | confirmed → confirmed | 更正是修订动作：新增不可变版本并指向前一版本，不产生 `corrected` 状态；旧版本保留，最新有效版本参与报表 |
| 对局 | draft/confirmed → voided；voided → draft | 作废保留版本链；恢复为 draft（待补充），须重新确认后才进入报表；作废/恢复均新增审计事实，不覆盖历史版本 |
| 头像资产 | ready → gc_pending | 单个一致数据库快照中零引用且零引用满 7 天 |
| 头像资产 | gc_pending → ready | 删除前发现新引用；取消清理 |
| 头像资产 | gc_pending → delete_pending | 事务锁定资产并再次检查全部引用仍为零；进入后禁止新增引用 |
| 头像资产 | delete_pending → deleted | 幂等物理删除成功或确认文件已不存在，再记录完成 |

状态不变的合法重试返回 `changed: false`；拒绝、回滚和 `changed: false` 都不递增对应 revision。过期可以由时间推导，不要求后台任务恰好在到期瞬间写状态。

## 迁移顺序与恢复边界

迁移只前向执行，每个版本有唯一序号和校验和；部署进程取得 PostgreSQL advisory lock，按序逐个事务执行。单个迁移必须可在一个事务完成；需要 `CREATE INDEX CONCURRENTLY` 等不能处于事务块的操作时，拆成明确的 preflight / non-transactional / verify 三个版本，并由该纵向票提供失败恢复手册，不能伪装成原子迁移。

| 阶段 | 逻辑内容 | 前置 | 失败停止点与恢复 |
|---:|---|---|---|
| 1 | 扩展、通用域、迁移账本 | 空库 | 当前事务回滚；修复原因后从同一版本重试 |
| 2 | identity：账号、令牌、会话 | 1 | 不进入 team；已提交旧版本不回退 |
| 3 | team 核心：团队、成员、绑定、角色、邀请 | 2 | 从失败版本重试；唯一约束验证后才继续 |
| 4 | 游戏项目、档案、模板、字段 | 3 | 不创建 activity 引用，修复后重试 |
| 5 | activity 核心：房间、访问会话、牌、认领、队伍 | 4 | 不创建对局/命令结果；修复后重试 |
| 6 | 对局版本与冻结快照 | 5 | 保持房间核心可迁移状态，修复后重试 |
| 7 | 幂等命令结果、审计、通知所需函数 | 6 | 验证事务行为后才开放写流量 |
| 8 | 头像资产元数据、引用外键、GC 状态 | 7 | 只建数据库模型，不创建物理占位文件 |
| 9 | reporting 只读索引/视图 | 8 | 失败不回滚业务数据；修复并重跑该版本 |
| 10 | 最终约束验证与 schema version gate | 9 | 应用拒绝启动写接口，直到校验成功 |

恢复边界是“最近已提交且校验和匹配的迁移版本”。失败版本若在事务内则没有部分 schema；非事务版本必须先由 verify 判断对象是否完整，再继续或按该版本手册清理，禁止盲目重跑。破坏性变更采用 expand → backfill → validate → switch readers/writers → contract，且每步由实际消费它的纵向票交付；数据库备份恢复不等于 migration down。

## 约束与领域校验归属

| 不变量 | 数据库约束 | 锁 / 条件写 | 领域校验 |
|---|---|---|---|
| 稳定 ID 和引用存在 | PK、FK、`NOT NULL` | — | 生成新 ID，不复用 |
| 同团队账号最多绑定一个成员；成员最多绑定一个账号 | 两个 partial unique 约束 | 锁账号团队绑定唯一键，再锁目标 member | 账号已验证、成员启用 |
| 同成员/项目唯一游戏档案 | `UNIQUE(member_id, game_project_id)` | 锁 member + project + 游戏档案唯一键，再插入 | 项目/成员启用、权限 |
| 同成员最多一个有效邀请；同团队邮箱最多一个有效邀请 | 对 active/pending 投影的 partial unique 约束 | 锁成员、团队邮箱 advisory key | 邮箱匹配、期限、撤销状态 |
| 团队至少一名有效管理员 | FK/检查不能表达跨行计数 | 锁 team 后重算有效管理员 | 目标资格与命令权限 |
| 开放房间恰有一个合格主持人 | FK 保证引用，唯一当前主持关系 | 锁旧/新 member，再锁 room | 启用、绑定、团队一致、接管资格 |
| 同房间一张牌最多一个有效认领；房间访问会话最多认领一张牌 | 两个 partial unique 约束 | 锁 room、card、房间访问会话 | 会话有效、权限 |
| 队伍人数不超容量 | 非负容量 CHECK | 锁 room、room_team 后计数 | 超员状态下只允许移出、不允许新增 |
| `expected*Revision` 不可错用 | revision 非负 CHECK | `UPDATE ... WHERE id=? AND revision=?` | 命令类型绑定相应字段名 |
| 命令 ID 在房间内唯一且指纹稳定 | PK (`room_id`,`command_id`) | 先按命令计划锁低 rank 前置对象，再锁 room 和命令结果 | 相同 ID 不同指纹为稳定冲突 |
| 访客牌最多归属一个成员且目标身份唯一 | FK、访客归属唯一约束 | 锁目标 member/profile，再锁 room、card | 主持权限、同项目、资料规则 |
| 头像只引用可新增引用的 ready 资产 | FK | 先锁业务聚合，再锁 asset | 授权、文件元数据完整、上下文可见性 |
| 快照历史不可被长期资料改写 | FK；快照行只插入不更新 | 创建时锁房间及来源行 | 复制完整显示/模板事实 |
| 最新有效对局版本唯一 | 版本链唯一约束 | 锁 room、match | 状态转换合法 |

CHECK、FK、unique 负责无论哪个调用者都必须成立的局部关系；锁负责跨行与竞态不变量；领域校验负责权限、状态转换和跨模块语义。三者不是互相替代。

## 统一锁顺序

所有写事务按下列全局 rank 升序获取锁；同一 rank 多行按稳定 UUID 字节序升序。禁止先锁子对象再补锁父对象，也禁止在持锁后调用会以更小 rank 加锁的查询。不存在实体行但必须串行化唯一键时，使用由命名空间和稳定业务键计算的 transaction-scoped advisory lock，放在对应 rank。

房间命令在事务外只从已验证的命令类型和稳定 ID 参数生成完整锁集合；先确定命令锁计划，再按全局 rank 升序逐一取得其中的锁，取锁后才读取并校验权威状态。普通房间内命令的计划是 room → command result → 所需子对象；涉及主持权或成员资格的命令先加入 team/member，涉及访客归属的命令先加入 team/member/project/profile 唯一键及已有 profile，涉及头像引用的命令再在末尾加入 asset。命令类型到锁类的映射是封闭枚举；缺失必要稳定 ID、未知命令类型或无法在取锁前确定唯一计划时，事务外拒绝，不允许持锁后追加更小 rank。这样所有房间命令仍只有一条由 rank 决定的总序，而不是一条通用 room 起始顺序和若干例外顺序。

| rank | 锁目标 |
|---:|---|
| 10 | `team_id`（团队行或团队命名空间 advisory key） |
| 15 | (`team_id`,`account_id`) 账号团队绑定唯一键 advisory lock |
| 20 | `member_id`，同 rank 多成员按 ID 排序 |
| 30 | `game_project_id` |
| 35 | (`member_id`,`game_project_id`) 游戏档案唯一键 advisory lock |
| 40 | `game_profile_id` |
| 45 | (`team_id`,规范化邮箱) 邀请唯一键 advisory lock |
| 50 | `invitation_id` |
| 60 | `room_id` |
| 65 | (`room_id`,`command_id`) 命令结果行 |
| 70 | `room_team_id` |
| 80 | `card_id` |
| 90 | `room_session_id` |
| 95 | `claim_id` |
| 100 | `match_id` |
| 110 | `avatar_asset_id` |

锁矩阵固定如下：

| 并发场景 | 必取锁（严格按 rank） | 串行化后校验 |
|---|---|---|
| 邀请接受 | team → 账号团队绑定唯一键 → member → invitation | 邀请有效、邮箱匹配、成员/账号均未冲突；最多一个成功 |
| 唯一游戏档案 | team → member → project → 游戏档案唯一键 | 成员/项目启用，插入唯一档案；并发收敛到一个 ID |
| 最后管理员 | team → 所有受影响 member（按 ID） | 重算有效管理员数，结果不得为 0 |
| 主持权转让/接管 | team → 旧/新 member（按 ID）→ room | 房间开放、旧主持仍当前、新主持合格 |
| 同牌认领 | room → card → 房间访问会话 | 牌与会话都未有有效认领 |
| 最后名额 | room → room_team → card | 锁内重算人数，新增后不超容量 |
| 同 revision 命令 | room → command result → 业务子对象 | `expectedRoomRevision` 只与当前 room 比较；一个改变，另一请求冲突或稳定重试 |
| 访客归属 | team → member → project → 游戏档案唯一键 → 已有 profile（如有）→ room → card | 访客未归属、目标成员/档案唯一且同项目 |
| 头像切换 | 成员：team → member → assets；档案：team → member → profile → assets；人员牌：room → command result → card → assets | 三种封闭命令各有唯一计划且始终依 rank 排序；分别校验 expectedMemberRevision / expectedProfileRevision / expectedRoomRevision；新资产可引用 |

跨模块“成员生命周期受开放房间主持权保护”也遵守 team → member → room；先锁团队和成员，再按 `room_id` 排序锁其主持的开放房间。GC 只锁 avatar asset，检查引用时不得再反向锁业务聚合；业务引用创建必须先锁聚合再锁 asset，因此 `delete_pending` 后不能新增引用。数据库死锁仍应作为可重试基础设施错误处理，但不能用重试掩盖违反统一顺序。

## 审计模型

`audit_entry` 是只追加事实，包含：`audit_id`、`occurred_at`、`module`、`action`、目标类型和稳定 ID、操作者类型与稳定 ID（系统任务用明确 system actor）、请求/追踪 ID、命令 ID（如有）、成功变更前后 revision、经字段白名单过滤的 before/after 摘要。密码、完整令牌、会话秘密、房间密码、观众链接秘密、CSRF 值、原始头像字节和本地绝对路径永不进入审计。

审计覆盖按模块固定如下，所有成功领域变化都在其业务数据库事务内追加：

- identity：身份安全事件，包括注册、邮箱验证、密码修改/重置、邮箱变更、当前/全端登出、会话撤销，以及登录、令牌、CSRF、限速相关的成功或拒绝安全事实；拒绝事实写独立安全事件，不伪装成领域变化。
- team：成员启停/恢复、绑定/解绑/离开、管理员授予/撤销、邀请签发/撤销/接受、项目创建/改名/停用/恢复、档案创建/修改/停用/恢复、模板发布/字段变更。
- activity：房间创建/结束/重新开放、房间删除/恢复/永久清理、访问模式变更、房间密码轮换、观众链接轮换、主持权转让/接管、人员牌创建/修改、认领/释放、分队变更、对局草稿创建/确认/更正/作废/恢复、访客归属。
- files：头像引用切换、GC 状态转换、物理删除和完整性故障。

事务回滚不留“成功”审计。所有审计和安全事件只保存白名单摘要，不携带秘密；高频认证拒绝可进入同一只追加安全事件模型并按安全策略留存，但不得省略父规格要求的身份安全可追溯性。

## 头像文件状态机

同步上传采用“文件先完成，数据库后引用”：服务端生成新的不透明 `avatar_asset_id`，在 webroot 外排他创建；完整校验并标准化为 PNG，写入、`Sync`、关闭后，才开启数据库事务插入 `ready` 元数据并切换业务引用。元数据至少含摘要、规范 MIME、字节数、宽高、编码版本、相对对象键和创建时间。

PostgreSQL 与本地文件不构成原子提交。数据库失败只留下不可见孤儿，由对账器在宽限后处理；数据库成功后若文件缺失或摘要不符是完整性故障，不能静默当默认头像并宣称成功。请求路径不删除旧文件，不覆盖现有对象。

GC 在一致数据库读取点枚举成员、游戏档案、人员牌和对局快照四类权威引用根。零引用满 7 天后标记 `gc_pending`；删除前事务锁资产并重新枚举引用，仍为零才进 `delete_pending`。该状态禁止新引用。持久化幂等任务删除物理文件：不存在视为已达成；其他失败保留 `delete_pending` 并重试；成功后写 `deleted`。物理删除成功但数据库更新失败时，下次以“不存在”收敛。对账发现有文件无数据库行则隔离后按宽限清理；有数据库 ready 引用无文件则报告完整性故障。

备份以同一 `backup_generation` 配对数据库导出、完整不可变头像集合和 manifest。在线模式先取得数据库一致快照，复制完成前冻结物理删除/GC；恢复必须校验所有引用的存在、大小和摘要。文件与 PostgreSQL 的这个恢复协议是跨存储一致性，不是原子提交承诺。

## 幂等命令结果模型

房间写命令以 (`room_id`,`command_id`) 唯一。`request_fingerprint` 对命令类型、规范化业务参数、调用主体/房间访问身份和该命令声明的全部 expected revisions 做稳定编码；不包含追踪 ID、时间戳等传输噪声。

事务流程固定为：根据命令类型形成完整锁计划 → 按 rank 取得 team/member/project/profile 等前置锁（该命令需要时）、room、command result 和业务子对象锁 → 若已有结果则校验指纹 → 重新鉴权 → 分别校验该命令声明的 expected revisions → 执行业务规则。稳定重试也取得同一命令类型的同一锁类集合，不能用“先查结果”绕过总序。相同 ID、相同指纹且已完成时原样返回保存的稳定结果；相同 ID、不同指纹返回 `command_id_reused`，不得执行。首次合法命令若没有状态变化，保存 `changed: false` 与当前 `room_revision`；若有变化，只把 `room_revision` 增加 1，保存 `changed: true`、新 revision 和最小稳定结果。

业务状态写入、审计、命令结果、`room_revision` 条件更新和 `pg_notify(channel, {roomId, revision})` 必须处于同一个 PostgreSQL 事务。只有 `changed: true` 调用 NOTIFY；PostgreSQL 在提交后投递。任一步失败整体回滚，因此回滚、权限拒绝、revision 冲突和 `changed: false` 均不递增、不通知。通知只是失效 hint，不是结果或历史；payload 只含房间 ID 与 revision。

## 一致读取点

角色化房间快照在一个只读事务的单个一致读取点完成：先在该事务重新鉴权并固定访问角色，再读取 room revision、能力、牌、认领、队伍、对局摘要及当前角色可见字段。实现可用一个组合查询，也可在 `REPEATABLE READ READ ONLY` 事务中运行多个按用例查询；不得每个查询各自隐式提交。返回的顶层 revision 必须与所有字段来自同一 snapshot，且响应禁止缓存。

reporting 的历史、基础统计和六张 CSV（对局、队伍、人员、队伍字段值、个人字段值、审计事件）同样使用一个 `REPEATABLE READ READ ONLY` 事务和单个一致读取点。六类文件以稳定 ID 互相追溯，字段值文件按稳定 `field_id` 输出，审计事件只输出允许管理员导出的白名单事实。先在事务中确认当前有效管理员，再由同一 snapshot 读取所有六表；不得逐个文件开事务，也不得持久化导出文件。并发更正只能整体出现在该读取点之前或之后，不能跨 CSV 混合版本。

只读事务不取得业务写锁；一致性来自 PostgreSQL MVCC snapshot。长导出设置明确超时并及时结束，不能让 snapshot 无限占用资源。

## sqlc seam

sqlc 是各深模块内部的 PostgreSQL adapter 生成器，不是跨模块公共 interface。查询按模块用例组织，不按表生成通用 CRUD；调用者只学习用例接口、revision 与稳定错误语义，不学习 `pgx.Tx` 或锁 SQL。单一所有者命令由对应深 Module 自行开启、提交或回滚事务；HTTP Adapter 与应用组装层不持有业务事务。只有必须原子改变多个 Module 所有权事实的用例，才由最外层用例协调者持有一个共享事务，并按统一锁顺序调用各 Module 的事务内 seam。

| 模块查询文件（由首个消费者创建） | 用例组 | 必须封装的持久化语义 |
|---|---|---|
| `identity/accounts.sql` | 注册、验证、登录、邮箱/密码变更 | 规范化邮箱唯一、令牌 generation、会话撤销 |
| `team/members.sql` | 创建团队/成员、停用/恢复、绑定/解绑/离开、角色 | member 条件 revision、最后管理员锁、审计 |
| `team/invitations.sql` | 签发、撤销、接受邀请 | 邀请/邮箱唯一键锁、原子绑定、稳定结果 |
| `team/game_profiles.sql` | 项目、档案、模板版本 | project/profile 条件 revision、唯一档案 |
| `activity/rooms.sql` | 建房、结束、删除/恢复、主持权 | room 锁和 room revision |
| `activity/cards.sql` | 建牌、认领、释放、分队、访客归属 | card/session/team 容量锁与快照冻结 |
| `activity/matches.sql` | 草稿、确认、更正、作废、恢复 | 不可变版本链和完整对局快照 |
| `activity/commands.sql` | 所有房间命令幂等封套 | 指纹、结果缓存、条件 revision、changed/NOTIFY |
| `activity/snapshots.sql` | 角色化完整房间快照 | 必须由一致只读事务调用，不暴露无鉴权组合片段 |
| `files/avatars.sql` | 元数据发布、引用切换、GC/对账 | ready 引用门、asset 锁、四类引用根复核 |
| `reporting/exports.sql` | 历史、统计、六张 CSV | 同一只读事务、最新有效对局版本、只读 |
| `audit/entries.sql` | 追加审计 | 字段白名单、与业务事务共同提交 |

外部模块 interface 保持按目标行为命名的小表面，例如执行成员生命周期命令、执行房间命令、读取角色快照、生成管理员导出；不得暴露 `CreateMemberRow`、`UpdateRoomTable` 一类表级方法。只有 PostgreSQL 一个实现时不额外发明 repository port；真实 PostgreSQL 是锁、事务、unique、LISTEN/NOTIFY 和一致 snapshot 的验收 adapter，不能用 mock 声称这些语义通过。文件能力因存在真实文件 adapter 和测试 stand-in，可在其实际纵向票形成 seam。

sqlc 查询返回数据库事实和受影响行数；领域模块把“零行”解释为 revision 冲突、状态冲突或不存在，并通过必要的同事务读取映射稳定错误。禁止依赖数据库错误字符串驱动领域结果。查询命名和参数必须体现 revision 归属，例如 `UpdateMemberIfRevision(expected_member_revision)`，不能使用模糊 `expected_revision`。

## 后续纵向票消费规则

1. 首个消费某一用例的纵向票同时创建对应 migration 与 sqlc 查询，并以公开 HTTP/模块 seam 先取得 RED，再做最小 GREEN；本票不预实现。
2. 每张票只实现其实际使用的模型切片，但不得改变稳定 ID、revision 归属、状态转换、全局锁 rank、同事务通知或一致读取规则；需要改变时先版本化修订本文。
3. 真实 PostgreSQL 并发验收必须覆盖邀请接受、唯一游戏档案、最后管理员、主持权、同牌认领、最后名额、同 revision 命令、访客归属和头像切换，证明最多一个冲突操作成功且无部分状态。
4. 事务故障注入必须证明业务状态、审计、命令结果、room revision 和 NOTIFY 同生共死；`changed: false` 和回滚均无 revision/通知。
5. 角色快照与六张 CSV 必须在并发写入下证明单个一致读取点，不得以单查询单元测试代替。
6. 文件测试必须分别注入“文件成功、数据库失败”“数据库引用缺文件”“物理删除成功、状态更新失败”；验收结果只能是可检测、可对账、可重试，不能宣称跨存储原子性。
7. 禁止创建空 migration、占位 SQL、通用表 CRUD、未被后续纵向票消费的 port 或 B-01 骨架。
