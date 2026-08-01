# 多人实时网页版 MVP 的最小技术路线

- 研究票：[调研多人实时网页版 MVP 的最小技术路线](https://github.com/gofromzero/TTSync/issues/5)
- 调研日期：2026-08-01
- 范围：只决定 MVP 技术路线，不实现产品代码
- 资料边界：只使用标准组织、数据库项目和产品自身的官方资料

## 结论

MVP 建议采用：**静态 TypeScript SPA + 单节点 PocketBase + SQLite + HTTP JSON 命令/快照 + PocketBase SSE 实时订阅**。

这条路线直接复用 PocketBase 已有的认证、规则、事务、迁移、SQLite 持久化、REST-ish API、静态资源托管和 SSE，服务端只补 TTSync 必需的房间访问交换与原子业务命令。PocketBase 官方将其定位为一个带 SQLite、认证、实时订阅和 API 的自包含后端，也能直接托管 `pb_public` 静态资源；自定义逻辑可以放在 JS hooks/route 中。[PocketBase 介绍](https://pocketbase.io/docs/) · [自定义 JS 路由](https://pocketbase.io/docs/js-routing/) · [实时 API](https://pocketbase.io/docs/api-realtime/)

第一版不需要 SSR、GraphQL、WebSocket、Redis、消息队列、微服务或独立 API 网关。网页端的写操作本来就是低频 HTTP 命令，实时需求是服务器向多个页面推送已提交的状态变化；Web 标准原生的 `EventSource`/SSE 就是这种单向服务器推送机制。[WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)

PocketBase 的硬边界是**只做单机纵向扩展**，且当前仍未到 v1.0、官方不建议直接用于不能容忍升级迁移的关键生产系统。[PocketBase FAQ](https://pocketbase.io/faq/) · [PocketBase 兼容性提示](https://pocketbase.io/docs/)。TTSync 是非资金、非关键业务的游戏协作工具，若下面的容量与可用性假设成立，这个取舍合理；若不能接受单机停机或跟随变更日志，则在开工前改选 Supabase。

## 决策所依赖的假设

这些是本研究为选型采用的规划值，不是厂商容量承诺，也尚未得到真实流量验证：

- 每个房间不超过 30 张人员牌、8 支队伍、100 名同时在线观众。
- 首发阶段总并发实时连接不超过 300，单房间已提交状态变更峰值不超过 2 次/秒。
- 拖拽过程中不发送网络写入，只在放下后提交一次；普通观看不会产生数据库写入。
- 部署在单一区域；允许计划内维护，目标 RPO 不高于 24 小时、RTO 不高于 4 小时。
- 房间展示的是明确允许公开的比赛/分队数据；邮箱、访问凭据和管理字段绝不进入观众快照。
- 小程序只要求未来能复用 HTTP JSON 业务 API；本期不承诺直接复用网页端 SSE 客户端。

只要其中任一项不成立，就应重新打开技术路线决策，而不是继续在单机方案上补分布式组件。

## 统一访问模型

“无需登录”应解释为**用户无需注册或输入账号**，而不是后端完全不鉴权。浏览器在后台换取短期、限房间、限角色的访问令牌，才能让服务端和实时订阅可靠地区分参与者与观众。

| 入口 | 用户提供的凭据 | 后端会话 | 权限 |
| --- | --- | --- | --- |
| 主持人 | 主持人邮箱和密码 | 长期主持人令牌 | 管理所属团队、游戏、房间、分队和记录 |
| 参与者 | 房间标识和房间密码 | 短期 `participant` 房间令牌 | 查看房间、直接认领未认领人员牌、修改被允许的本人资料 |
| 观众 | 可轮换的高熵只读分享链接 | 短期 `spectator` 房间令牌，后台自动换取 | 只读公开房间快照和实时更新，不占人数、不认领人员牌 |

共同安全规则：

- 房间密码和观众链接密钥只在 HTTPS 请求中提交，由服务端验证；数据库只存密码散列，不将原文放进普通房间记录、前端包或日志。观众链接密钥应随机生成、可轮换，不能使用可猜的房间编号。
- 参与者入口按 IP 和房间双维度限速，并返回统一错误，避免暴力尝试和房间枚举。PocketBase 自带可配置限流器，但官方要求生产环境主动启用。[PocketBase 生产建议](https://pocketbase.io/docs/going-to-production/)
- 角色由换取凭据的服务端路由确定，客户端不能提交 `role=host` 或自行扩大权限。
- 主持人重置房间密码或观众链接时，同时吊销对应房间访客会话；PocketBase auth record 可刷新 token key，服务端也能签发和验证 record JWT。[PocketBase record auth/token API](https://pocketbase.io/docs/js-records/)
- UI 的“满员不可拖入”只是提示；容量、认领唯一性、主持人归属和字段白名单必须由服务端事务再次检查。PocketBase 提供 `runInTransaction`，失败时不会持久化事务内操作。[PocketBase JS 事务](https://pocketbase.io/docs/js-records/#transaction)

## 推荐路线：PocketBase 单节点

### 最小组成

1. 一个静态 SPA。仓库没有既有前端约束；实现阶段应使用团队最熟悉的轻量方案。若没有偏好，可用 React + TypeScript + Vite，但它不是后端决策的前置条件。
2. 一个 PocketBase 进程，使用内置 SQLite。`pb_migrations` 保存可提交的结构迁移，`pb_hooks` 保存少量自定义路由和事务命令。[PocketBase 迁移](https://pocketbase.io/docs/js-migrations/)
3. 一个持久卷保存 `pb_data`，另有异机或 S3 兼容存储保存备份。PocketBase 支持完整快照备份；官方提醒 `pb_data` 到约 2 GB 以上时应改用专门备份方案。[PocketBase 备份与恢复](https://pocketbase.io/docs/going-to-production/#backup-and-restore)
4. 一个长期运行的 Linux 服务或容器。PocketBase 可单二进制部署并自动管理 TLS，也可置于反向代理后；SSE 需要代理保留长连接。[PocketBase 部署](https://pocketbase.io/docs/going-to-production/)

### 各需求如何落地

- **主持人登录**：使用独立的 `hosts` auth collection 和 PocketBase 原生密码认证；auth collection 可配置邮箱或其他唯一身份字段。[PocketBase 密码认证](https://pocketbase.io/docs/authentication/#authenticate-with-password)
- **房间密码参与**：锁定的房间凭据记录保存密码散列。自定义 `join` 路由调用 `validatePassword`，成功后创建短期 `room_sessions` auth record，绑定 `room_id`、`role=participant` 和过期时间，再返回标准 auth response。PocketBase 官方路由 API 已提供 `recordAuthResponse`、认证中间件和通用错误处理。[PocketBase 自定义认证路由](https://pocketbase.io/docs/js-routing/#auth-response)
- **匿名只读观众**：分享链接携带独立随机密钥；自定义 `spectate` 路由验证后签发 `role=spectator` 的房间会话。页面没有注册、登录或输密码步骤，但数据库和 SSE 仍能执行只读规则。
- **权限**：collection API rules 根据当前 auth record 的 `room_id`、`role` 和主持人关系过滤读写；规则还能读取请求头、查询、body 和关联集合。[PocketBase API rules](https://pocketbase.io/docs/api-rules-and-filters/)
- **实时查看**：页面先拉取房间快照，再订阅该房间的记录主题。PocketBase Realtime 使用 SSE，单记录订阅会执行该 collection 的 `viewRule`，集合订阅会执行 `listRule`。[PocketBase Realtime 授权](https://pocketbase.io/docs/api-realtime/)
- **持久化与历史**：当前分队、人员牌、局快照和记录模板都写 SQLite；“开始本局”在一个事务内冻结快照。实时消息不是数据源，断线或版本跳跃时重新取快照。
- **未来 API 客户端**：小程序调用同一组 `/api/ttsync/*` HTTP JSON 路由。不要让网页组件直接依赖每张 PocketBase 表的 CRUD 形状；把加入房间、认领、移动、开始本局和录入结果保留为稳定的业务命令。小程序实时传输方式到第二阶段再决定，首版可先重取快照，不需要现在增加 WebSocket 网关。

短期访客会话会产生记录，因此需要一个按过期时间清理的定时任务。这比把参与者和观众都当成公开访客多一点数据，但能阻止观众认领人员牌，也能把某张牌绑定到一次独立参与者会话；这是满足现有权限语义的最小安全成本。

### 房间状态与并发约束

最小一致性流程为：`GET 快照 -> 订阅房间 -> POST 命令(expectedVersion) -> 服务端事务提交并递增 version -> SSE 通知 -> 其他页面更新或重取快照`。

- 每个会改变房间布局的主持人命令携带 `expectedVersion`；版本冲突返回最新快照，不做静默覆盖。
- 人员牌认领使用事务和唯一约束，两个参与者同时认领时只能一个成功。
- 拖拽只改变主持人的本地预览；`drop` 后才调用一次移动命令。不要广播 `drag`/`dragover` 坐标。
- 观众收到的是服务端已提交状态，不展示主持人的未提交拖拽过程。
- 实时连接重连后始终允许重新拉取完整快照，不能依赖“从未漏过事件”的假设。

### 拖拽 UI

桌面端先使用浏览器原生 HTML Drag and Drop；标准已经定义 `draggable`、`DragEvent`、`DataTransfer` 和 `drop` 流程，不需要为了第一版引入拖拽库。[WHATWG Drag and Drop](https://html.spec.whatwg.org/multipage/dnd.html)

同时必须为每张人员牌提供“移动到某队/待分配区”的按钮或选择框，并支持键盘操作。HTML 标准的移动端兼容信息并不完整，而 WCAG 2.2 的 2.5.7 要求依赖拖动的功能也能用不拖动的单指针操作完成；这个替代控件同时解决触屏和无障碍，不需要现在实现另一套手势系统。[WCAG 2.2 Dragging Movements](https://www.w3.org/TR/WCAG22/#dragging-movements)

若后续明确要求主持人在触屏上也获得原生感的拖拽排序，再根据原型结果选择拖拽库；当前没有证据需要提前增加依赖。

## 可行替代路线

| 路线 | 能力复用 | 精确匹配本产品的额外工作 | 运维和扩展边界 | 结论 |
| --- | --- | --- | --- | --- |
| **PocketBase + 静态 SPA** | auth、API rules、SQLite、事务、迁移、SSE、静态托管、备份 | 两个凭据交换入口、短期房间会话、业务事务命令 | 自托管、单节点纵向扩展、pre-v1 升级纪律 | **MVP 首选，代码和组件最少** |
| **Supabase + 静态 SPA** | 托管 Postgres、Auth、RLS、REST API、Realtime、Edge Functions、托管备份 | 房间密码交换、观众 capability、匿名会话清理、RLS 与 Realtime 授权策略 | 托管可用性更好；连接/消息按套餐配额；授权吞吐需设计 | 不能接受单节点或希望托管数据库时选 |
| **自建单体 API + PostgreSQL + SSE** | 只复用语言标准库、PostgreSQL 和浏览器 SSE | 全部认证、令牌、授权、限流、订阅、迁移、备份与管理界面 | 控制力最高；实现和长期运维工作最多；多实例还需广播层 | MVP 不选；有明确合规或平台约束时再建 |

### Supabase 路线的事实与代价

Supabase 可以满足所有功能：主持人使用密码 Auth；浏览器通过 Auth JWT 和 Postgres RLS 获得行级权限；Edge Function 验证房间凭据；Postgres Changes 或 Broadcast 推送变化；自动生成的 REST API 可被网页或未来客户端调用。[Supabase 密码 Auth](https://supabase.com/docs/guides/auth/passwords) · [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) · [REST API](https://supabase.com/docs/guides/api) · [Edge Function 鉴权](https://supabase.com/docs/guides/functions/auth)

但它并不会免费消除房间访问模型：

- 无 UI 登录可用 anonymous sign-in，然后在 `room_access` 表里授予房间角色；匿名用户仍使用 `authenticated` 数据库角色，需要用 JWT 的 `is_anonymous` 和 RLS 区分。官方默认按 IP 限制匿名注册为每小时 30 次，并建议 CAPTCHA，且不会自动清理匿名用户。多人在同一场地共享公网 IP 时，这会成为实际风险。[Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- 若为绕开匿名注册限流而使用公开观众频道或自签房间 JWT，就需要额外维护 capability、签名和撤销逻辑；这使其对当前“匿名观众 + 房间密码参与”语义不再比 PocketBase 更短。
- Postgres Changes 会对每个事件、每个订阅者执行一次授权，并为保持顺序单线程处理；官方建议同一变化超过约 3,000 个并发订阅者时改用 Broadcast。[Supabase Postgres Changes 扩展说明](https://supabase.com/docs/guides/realtime/postgres-changes/#scaling-postgres-changes)
- 当前托管配额中 Free/Pro 默认分别为 200/500 个并发 Realtime 连接；Pro 无 spend cap 与 Team 为 10,000。目标规模一旦超过套餐默认值，需要升配或申请调整，不能只看数据库规格。[Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- 托管 Postgres 提供日备份，PITR 是付费选项；这是它相对单节点 PocketBase 的主要运维优势。[Supabase database backups](https://supabase.com/features/database-backups)

因此，**可用性与托管运维优先时选择 Supabase；最短 MVP 和自托管可控优先时选择 PocketBase**。

### 自建单体路线何时才合理

自建 API 仍应使用 HTTP 命令 + SSE，而不是一开始使用双向 WebSocket：浏览器所有写入都可走普通 HTTP，SSE 是标准化的服务器到页面推送。[WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)

只有出现以下硬约束才值得承担完整自建成本：组织禁止 pre-v1 组件，也禁止托管 BaaS；必须使用既有 PostgreSQL/身份平台；或必须从第一天满足多实例、审计和特定 RTO/RPO。否则它只是重写 PocketBase 已经提供的认证、规则、实时和管理能力。

## 容量闸门与最小验证

PocketBase 官方称在 2 vCPU、4 GB RAM 的廉价 VPS 上可服务 10,000+ 持久实时连接，但同一 FAQ 明确说明它只支持单机纵向扩展；该数字也不是 TTSync 业务事务和负载形态的保证。[PocketBase scaling FAQ](https://pocketbase.io/faq/)

因此采用更保守的项目闸门：

- 首次上线前，用接近生产规格的实例验证 **600 个 SSE 连接、每房间 4 次已提交变更/秒、持续 30 分钟**；这是当前规划目标的 2 倍。
- 验收目标：命令成功率 100%，其他页面看到提交结果的 p95 小于 1 秒；断线重连后快照一致；20 个并发认领请求只有一个成功。
- 验证进程重启后的自动重连与快照恢复，并实际执行一次异机备份恢复。
- 总连接持续超过 1,000、单房间持续超过 2 次提交/秒、`pb_data` 接近 2 GB，或文件描述符/CPU/写事务成为瓶颈时，必须重新压测和评审；PocketBase 官方也提醒大量实时连接需要提高文件描述符上限。[PocketBase production limits](https://pocketbase.io/docs/going-to-production/#increase-the-open-file-descriptors-limit)
- 一旦要求无单点、滚动零停机、RTO 小于 1 小时或多区域部署，不等待流量阈值，直接重开路线决策并优先评估 Supabase/Broadcast 或专门的分布式后端。
- 若同一房间未来达到约 3,000 个 Supabase Postgres Changes 订阅者，则按官方建议切 Broadcast，而不是继续堆数据库算力。[Supabase scaling guidance](https://supabase.com/docs/guides/realtime/postgres-changes/#scaling-postgres-changes)

这些是架构复审触发器，不是提前实现扩容组件的理由。

## 最终决策建议

在上述假设下锁定 PocketBase 路线，并把以下内容作为实现规格的边界：

1. 权威状态只存在数据库；HTTP 命令负责写，SSE 负责通知。
2. 主持人、参与者、观众使用服务端签发的不同作用域令牌；匿名观众只是不需要账号，不是公开写权限。
3. 所有分队容量、认领和局快照规则在服务端事务内执行。
4. 网页与未来小程序共享 HTTP JSON 业务 API，不共享 UI，也不提前承诺共享实时传输实现。
5. 单节点、pre-v1 和备份恢复是接受 PocketBase 时必须显式接受的限制。

改选 Supabase 的充分条件是：项目在编码前就要求托管数据库/备份或不能容忍单节点维护。自建 PostgreSQL 单体不进入 MVP，除非两条现成路线都被明确的平台或合规约束排除。
