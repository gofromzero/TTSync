# 自托管 Supabase 的最小备份、恢复与升级方案

- 研究票：[调研自托管 Supabase 的最小备份恢复与升级方案](https://github.com/gofromzero/TTSync/issues/12)
- 调研日期：2026-08-01
- 固定边界：自有或腾讯云 Linux 单机，自托管 Supabase；每日异地备份；RPO 24 小时、RTO 4 小时；接受维护停机
- 资料边界：只使用 Supabase、PostgreSQL、Docker 与腾讯云官方资料

## 结论

第一版采用一个可独立恢复的**每日恢复集**：

1. 每天短暂停止整套 Supabase，把已停库的完整 `volumes/db/data` 与本地 Storage 一起冷备；这比拼装多个在线导出更完整，也能保证两者来自同一时点。
2. 同一恢复集带上 `db-config` 命名卷、部署配置、运行密钥、函数代码和校验清单。
3. 加密后上传到与运行服务器不同地域的腾讯云 COS 私有桶；开启版本控制，保留最近 30 个每日恢复集。
4. 上线前完成一次隔离恢复，此后每季度以及每次升级前演练；从宣告恢复开始，到网页核心流程验证通过，必须不超过 4 小时。

本阶段不做 WAL/PITR、高可用、热备、Kubernetes 或专用备份平台。自托管版不提供托管备份与 PITR，备份和灾难恢复本来就是部署方责任；当前规模和“接受停机”的边界用每日冷备即可覆盖。[Supabase 自托管责任边界](https://supabase.com/docs/guides/self-hosting)

## 一个恢复集必须包含什么

| 工件 | 必须保存的内容 | 恢复意义 |
| --- | --- | --- |
| 数据库 | 停止 PostgreSQL 后完整归档 `volumes/db/data` | 保存全部数据库、角色、扩展和 Supabase 内部状态；文件级备份必须停库，并且只能整集群恢复。[PostgreSQL 文件级备份](https://www.postgresql.org/docs/17/backup-file.html) |
| Storage | 默认文件后端的整个 `volumes/storage` 目录；若以后改为 S3 后端，则保存对应桶中的全部对象 | 数据库备份不包含文件对象；默认自托管 Storage 使用本地 bind mount。[Storage 后端边界](https://supabase.com/docs/guides/self-hosting/self-hosted-s3) |
| 数据库外部密钥 | `db-config` 命名卷内的 `/etc/postgresql-custom/pgsodium_root.key`，以及使用中的 `conf.d/*.conf` | 丢失根密钥后，Vault 中已有密文不可恢复；`conf.d` 也持久化在该卷中。绝不能执行 `docker compose down -v`。[PostgreSQL 17 升级说明](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17) |
| 部署与运行配置 | `.env`、当前 `docker-compose.yml` 与全部启用的 override、`run.sh`、`volumes/api`、`volumes/db/*.sql`、`volumes/pooler`、`volumes/functions`，以及实际使用时的 `volumes/snippets` | `.env` 保存数据库密码、JWT/API 密钥、Realtime/Supavisor 加密密钥、SMTP 等运行状态；Edge Functions 直接从 `volumes/functions` 加载。[Docker 部署配置](https://supabase.com/docs/guides/self-hosting/docker) · [官方固定发布版的 Compose 挂载](https://github.com/supabase/supabase/blob/self-hosted/v0.7.0/docker/docker-compose.yml) |
| TTSync 部署清单 | TTSync 发布提交、Supabase Docker 配置提交、所有镜像 tag 与 digest、PostgreSQL 版本、已启用扩展、备份 UTC 时间、各工件大小与 SHA-256、关键表行数、Storage 对象数 | 让新主机恢复到确定且可复现的同一版本，而不是临时拉取 `latest`。 |
| 服务器外部配置 | 反向代理配置、域名/DNS、OAuth 回调、SMTP、COS 桶地域/版本控制/生命周期和 CAM 策略的恢复说明 | 官方明确列出 JWT/API 密钥、Auth provider、Edge Functions、Storage 对象、SMTP、域名/DNS 均不由数据库恢复自动补齐。[数据库备份之外的内容](https://supabase.com/docs/guides/self-hosting/restore-from-platform#whats-included-in-the-restore-and-whats-not) |

整个含密钥的恢复集必须先加密再离开服务器；解密密钥和 COS 恢复账号不得只存在于该服务器。COS 使用单独的 CAM 子账号并遵循最小权限，日常上传凭据不授予永久删除历史版本的权限。[腾讯云 CAM 最小权限原则](https://cloud.tencent.com/document/product/598/13665)

不必备份容器、`deno-cache`、可重新拉取的镜像和普通运行日志；它们不是权威业务状态。若未来日志承担审计义务，再把日志保留单独纳入范围。绝不复制仍在运行的 `volumes/db/data`：PostgreSQL 官方要求普通文件级备份必须停库；在线物理备份则需要可信的一致快照并包含 WAL。[PostgreSQL 文件级备份限制](https://www.postgresql.org/docs/17/backup-file.html)

Supabase CLI 的 roles/schema/data 三文件适合迁移到一个已初始化的新 Supabase：它会主动过滤内部 schema 和保留角色，因此**不作为本方案唯一的整机灾备**。PostgreSQL 大版本升级前可额外生成 `pg_dumpall` 作为独立的逻辑保险；Supabase 官方升级指南也把它列为可选备份。[Supabase 迁移导出边界](https://supabase.com/docs/guides/self-hosting/restore-from-platform) · [`pg_dumpall` 全集群导出](https://www.postgresql.org/docs/17/app-pg-dumpall.html) · [Supabase 升级前备份](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17#create-a-backup)

## 每日备份流程

1. 进入维护模式并停止整套 Supabase；确认没有运行中的数据库或 Storage 写入。停止容器时不得带 `-v`。官方 `reset.sh` 会删除数据库目录、Storage 和命名卷，生产环境禁用该命令。[Supabase 卸载警告](https://supabase.com/docs/guides/self-hosting/docker#uninstalling)
2. 保留文件所有权和权限，完整归档 `volumes/db/data`、`volumes/storage` 与 `db-config` 命名卷，再收集上节列出的配置和清单。Docker 官方也将命名卷的 tar/untar 作为备份与恢复方式。[Docker volume 备份恢复](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)
3. 本地恢复集生成完并通过 SHA-256 后重启原栈；异地上传不占用停机窗口。
4. 为每个工件生成 SHA-256，将恢复集整体加密并上传至异地域 COS；上传完成后校验远端对象。COS 会为新上传对象保存并返回 CRC64，可用于核对传输完整性；SHA-256 清单仍作为恢复集自身的端到端校验。[COS CRC64 校验](https://cloud.tencent.com/document/product/436/40334)
5. COS 桶开启版本控制；普通删除只形成删除标记，可恢复旧版本。保留 30 个每日版本，再由生命周期清理更旧的非当前版本。[COS 版本控制](https://cloud.tencent.com/document/product/436/19883) · [非当前版本生命周期](https://cloud.tencent.com/document/product/436/17029)

一次备份只有在**异地上传完成、校验通过且清单登记完成**后才算成功。上一个成功恢复点达到 20 小时时告警并立即重试；达到 24 小时仍无新恢复点即为 RPO 违约，而不是继续等待下一天。

## 最小恢复演练

上线前一次，此后每季度一次；备份格式、Storage 后端、Auth 密钥方式、PostgreSQL 大版本或 Compose 结构变化时额外执行。演练使用隔离的新 Linux 主机，禁用真实邮件、OAuth 回调和其他外部副作用。

1. 从 COS 下载最新成功恢复集，验证 SHA-256 并解密；此刻开始记录 RTO。
2. 检出清单中的 TTSync 与 Supabase Docker 配置提交，按清单拉取固定镜像；恢复 `.env`、反向代理配置、Functions 和其他部署文件。
3. 在任何服务首次启动前，恢复完整 `volumes/db/data`、`volumes/storage` 和 `db-config` 卷，并按清单恢复文件所有权。原 `pgsodium_root.key` 必须随卷恢复；官方说明该密钥不在数据库中，Vault 数据离开原密钥将无法解密。[Vault 密钥位置与迁移](https://supabase.com/docs/guides/database/vault#encryption-key-location)
4. 用与备份完全相同的 PostgreSQL 主版本、Supabase 镜像和 Compose 配置启动；冷备只承诺恢复到该固定版本，升级另走下一节流程。
5. 验证全部 Compose 服务为 healthy；对照清单检查关键 TTSync 表、`auth.users`、Storage 元数据与对象数量；实际读取至少一个公开和一个私有对象。
6. 完成四条网页烟测：主持人登录；参与者凭房间密码进入并认领人员牌；主持人拖动人员牌并开始一局；匿名观众能看到变化但写接口被拒绝。以最后一条通过为 RTO 结束点。

演练通过标准同时满足：恢复点年龄不超过 24 小时、端到端恢复不超过 4 小时、所有校验无差异。目标预警线设为 3 小时，留下 1 小时处理 DNS、证书或回滚；每次保存各阶段耗时和失败原因，不能以“数据库已启动”代替业务恢复成功。

## 版本锁定与升级

1. 把一次 Supabase 官方 Docker 稳定发布的**整套** `docker/` 配置固定到提交，并保留其中所有明确 image tag；部署清单再记录实际 digest。Supabase 约每月发布一次经过组合测试的 Compose 版本，单独升级某个服务不保证兼容。[官方更新规则](https://supabase.com/docs/guides/self-hosting/docker#updating)
2. 每月只做更新评审：阅读 self-hosted `CHANGELOG.md` 和 `versions.md`，比较 `.env.example`、Compose、挂载和迁移变化。没有安全或所需修复时不必为了“追最新”升级。
3. 先用当前版本冷备在隔离环境完成恢复，再在该副本上应用候选整套版本。生产升级前生成即时异地冷备；数据库或大版本升级再加一份 `pg_dumpall`，并确认磁盘空间、扩展兼容性和回滚版本。
4. 在维护窗口内拉取固定镜像，停止旧栈时不得带 `-v`，以新配置启动并等待 healthy，再执行上一节四条烟测。
5. 只有无数据库变化的单服务升级才能仅回退 Compose/image；涉及数据库迁移或 PostgreSQL 大版本时，回滚必须使用升级前完整恢复集。升级前恢复集至少保留到下一次季度演练通过。

2026-08-01 的官方自托管新部署默认 PostgreSQL 17。若接手的是 PostgreSQL 15 数据，必须走官方 `utils/upgrade-pg17.sh`，不能让 17 镜像直接读取 15 数据目录；该流程要求至少“数据库大小的 2 倍 + 5 GB”空闲空间，并会保留原数据目录和根密钥供回滚。[Supabase PostgreSQL 17 升级指南](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17)

## 何时必须升级为更强方案

以下任一条件出现即重新决策，不在当前单机方案上继续打补丁：

- **RPO**：业务要求小于 24 小时，或滚动 30 天内发生 2 次异地备份未在 24 小时内成功。改为 PostgreSQL base backup + 持续 WAL 归档/PITR；PostgreSQL 官方说明该组合可连续恢复并停在指定时间点。[WAL/PITR](https://www.postgresql.org/docs/17/continuous-archiving.html)
- **RTO**：连续 2 次完整演练超过 3 小时，或单次下载超过 60 分钟、数据库恢复超过 120 分钟、Storage 恢复超过 60 分钟。先按实测瓶颈改用 PostgreSQL base backup/WAL、云盘一致快照或把 Storage 主后端迁至 S3 兼容对象存储；仍无法留下 1 小时缓冲时增加预热备用机。
- **可用性**：不再接受维护停机、要求 RTO 小于 4 小时，或要求服务器故障时自动切换。直接评估托管 PostgreSQL/高可用数据库与多节点应用，不把单机 Compose 包装成“高可用”。
- **完整性**：任一恢复集校验失败、根密钥缺失或季度演练无法完成核心烟测，立即视为无可用备份；停止升级并先修复备份链。
- **Storage 增长**：连续 2 次备份中，写冻结超过 15 分钟或 Storage 归档/恢复超过上面的 60 分钟预算。改用 Supabase 支持的 S3 后端并对对象存储单独做版本控制，不再扩大本地目录复制窗口。

这些阈值以已经确认的 RPO 24 小时、RTO 4 小时为依据；数据量本身不是升级理由，实际备份年龄和恢复耗时才是。

## 明确不做

- 不把云硬盘快照当成唯一备份，也不把同机目录副本称为异地备份。
- 不备份 Docker cache、容器层或可重建日志。
- 不为当前目标预先部署 WAL/PITR、热备、跨地域数据库复制、Kubernetes 或第三方备份编排器。
- 本研究不实现运维脚本；实现阶段只需把上述固定流程自动化，并保留一次可重复执行的恢复检查。
