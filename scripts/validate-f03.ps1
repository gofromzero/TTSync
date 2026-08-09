$ErrorActionPreference = 'Stop'

$specPath = Join-Path $PSScriptRoot '..\docs\architecture\postgresql-model-v1.md'
if (-not (Test-Path -LiteralPath $specPath)) {
    throw "F-03 设计制品不存在: $specPath"
}

$spec = Get-Content -Raw -LiteralPath $specPath
$required = @(
    '# PostgreSQL 持久化模型 v1',
    '## 聚合、稳定标识与修订号',
    '## 生命周期状态机',
    '## 迁移顺序与恢复边界',
    '## 约束与领域校验归属',
    '## 统一锁顺序',
    '## 审计模型',
    '## 头像文件状态机',
    '## 幂等命令结果模型',
    '## 一致读取点',
    '## sqlc seam',
    '## 后续纵向票消费规则'
)

foreach ($heading in $required) {
    if (-not $spec.Contains($heading)) {
        throw "F-03 缺少必需章节: $heading"
    }
}

$requiredScenarios = @(
    '邀请接受', '唯一游戏档案', '最后管理员', '主持权', '同牌认领',
    '最后名额', '同 revision 命令', '访客归属', '头像切换'
)
foreach ($scenario in $requiredScenarios) {
    if (-not $spec.Contains($scenario)) {
        throw "F-03 锁矩阵缺少场景: $scenario"
    }
}

$requiredSemantics = @(
    'changed: false', 'NOTIFY', '单个一致读取点', '六张 CSV',
    'PostgreSQL 与本地文件不构成原子提交', 'expectedMemberRevision',
    'expectedProjectRevision', 'expectedProfileRevision', 'expectedRoomRevision'
)
foreach ($semantic in $requiredSemantics) {
    if (-not $spec.Contains($semantic)) {
        throw "F-03 缺少关键语义: $semantic"
    }
}

if ($spec -match '(?m)^\| 对局 \|.*corrected') {
    throw 'F-03 对局生命周期不得包含 corrected 状态'
}
if (-not $spec.Contains('对局状态仅为 draft / confirmed / voided')) {
    throw 'F-03 必须固定对局的三种状态'
}
if (-not $spec.Contains('恢复为 draft')) {
    throw 'F-03 作废恢复必须回到待补充 draft'
}
if (-not $spec.Contains('ended → open')) {
    throw 'F-03 房间必须允许结束后重新开放'
}
if (-not $spec.Contains('30 天恢复期')) {
    throw 'F-03 房间删除必须固定 30 天恢复期'
}
if (-not $spec.Contains('永久清理后不可恢复')) {
    throw 'F-03 房间必须固定永久清理边界'
}
$csvSet = '对局、队伍、人员、队伍字段值、个人字段值、审计事件'
if (-not $spec.Contains("六张 CSV（$csvSet）")) {
    throw "F-03 六张 CSV 必须精确固定为: $csvSet"
}

if ($spec -match '(?i)\bTBD\b') {
    throw 'F-03 不允许包含 TBD'
}

$rankSection = [regex]::Match(
    $spec,
    '(?s)## 统一锁顺序\s+.*?\| rank \| 锁目标 \|.*?\n(?<rows>(?:\| \d+ \|.*\n)+)'
)
if (-not $rankSection.Success) {
    throw 'F-03 无法解析统一锁 rank 表'
}
$ranks = [regex]::Matches($rankSection.Groups['rows'].Value, '(?m)^\| (\d+) \|') |
    ForEach-Object { [int]$_.Groups[1].Value }
if ($ranks.Count -lt 10) {
    throw 'F-03 统一锁 rank 表不完整'
}
if ($rankSection.Groups['rows'].Value -match '(?m)^\| \d+ \|.*(?: / | 或 )') {
    throw 'F-03 每类锁对象必须拥有独立的全局 rank，不得在同一 rank 合并锁类'
}
if (-not $rankSection.Groups['rows'].Value.Contains('账号团队绑定唯一键')) {
    throw 'F-03 账号团队绑定唯一键缺少全局锁 rank'
}
if (-not $spec.Contains('先确定命令锁计划，再按全局 rank 升序')) {
    throw 'F-03 房间命令必须先确定唯一锁计划再取锁'
}
if ($spec.Contains('流程固定为：按全局顺序锁 room → 查/建命令结果')) {
    throw 'F-03 通用 room→command-result 流程与跨聚合房间命令冲突'
}
$matrixSection = [regex]::Match(
    $spec,
    '(?m)锁矩阵固定如下：\s+\| 并发场景 \|.*\r?\n\|---\|---\|---\|\r?\n(?<rows>(?:\|.*\r?\n)+)'
)
if (-not $matrixSection.Success) {
    throw 'F-03 无法解析九场景锁矩阵'
}
$matrixRows = [regex]::Matches($matrixSection.Groups['rows'].Value, '(?m)^\|')
if ($matrixRows.Count -ne 9) {
    throw "F-03 锁矩阵必须且只能包含九个并发场景，当前为 $($matrixRows.Count)"
}
$auditCoverage = @(
    '身份安全事件', '项目创建/停用/恢复', '档案创建/修改/停用/恢复',
    '模板发布/字段变更', '房间创建/结束/重新开放', '访问模式变更',
    '房间密码轮换', '观众链接轮换', '人员牌创建/修改', '认领/释放', '分队变更'
)
foreach ($auditItem in $auditCoverage) {
    if (-not $spec.Contains($auditItem)) {
        throw "F-03 审计覆盖缺少: $auditItem"
    }
}
$revisionBoundaries = @(
    'expectedProjectRevision',
    '旧 `member_revision` 拒绝',
    '旧 `project_revision` 拒绝',
    '旧 `profile_revision` 拒绝',
    '旧 `room_revision` 拒绝'
)
foreach ($revisionBoundary in $revisionBoundaries) {
    if (-not $spec.Contains($revisionBoundary)) {
        throw "F-03 revision 拒绝边界缺少: $revisionBoundary"
    }
}
for ($index = 1; $index -lt $ranks.Count; $index++) {
    if ($ranks[$index] -le $ranks[$index - 1]) {
        throw 'F-03 统一锁 rank 必须唯一且严格递增'
    }
}

Write-Output 'F-03 规范验证通过'
