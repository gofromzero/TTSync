param(
    [string]$SpecPath = (Join-Path $PSScriptRoot '..\docs\architecture\postgresql-model-v1.md'),
    [string]$ContextPath = (Join-Path $PSScriptRoot '..\CONTEXT.md'),
    [switch]$SkipNegativeTests
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SpecPath)) {
    throw "F-03 设计制品不存在: $SpecPath"
}
if (-not (Test-Path -LiteralPath $ContextPath)) {
    throw "F-03 领域语言文件不存在: $ContextPath"
}

$spec = Get-Content -Raw -LiteralPath $SpecPath
$context = Get-Content -Raw -LiteralPath $ContextPath
$roomAccessSessionEntries = [regex]::Matches($context, '(?m)^\*\*房间访问会话\*\*:\r?$')
if ($roomAccessSessionEntries.Count -ne 1) {
    throw ('F-03 CONTEXT.md 必须且只能定义一个“房间访问会话”词条，当前为 {0}' -f $roomAccessSessionEntries.Count)
}
if ($context.Contains('参与者会话')) {
    throw 'F-03 CONTEXT.md 术语漂移: 旧词“参与者会话”应统一为“房间访问会话”'
}
if ($context -match '(?i)participant session') {
    throw 'F-03 CONTEXT.md 术语漂移: 旧词 participant session 应统一为“房间访问会话”'
}
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

function Get-LockKindRanks {
    param([string]$RankRows)

    $result = @{}
    foreach ($rowMatch in [regex]::Matches($RankRows, '(?m)^\| (?<rank>\d+) \| (?<target>.*?) \|$')) {
        $rank = [int]$rowMatch.Groups['rank'].Value
        $target = $rowMatch.Groups['target'].Value
        $kind = switch -Regex ($target) {
            '^\(`team_id`,`account_id`\)' { 'account-team-key'; break }
            '^`team_id`' { 'team'; break }
            '^`member_id`' { 'member'; break }
            '^`game_project_id`' { 'project'; break }
            '^\(`member_id`,`game_project_id`\)' { 'profile-key'; break }
            '^`game_profile_id`' { 'profile'; break }
            '规范化邮箱' { 'invitation-key'; break }
            '^`invitation_id`' { 'invitation'; break }
            '^\(`room_id`,`command_id`\)' { 'command-result'; break }
            '^`room_id`' { 'room'; break }
            '^`room_team_id`' { 'room-team'; break }
            '^`card_id`' { 'card'; break }
            '^`room_session_id`' { 'room-session'; break }
            '^`claim_id`' { 'claim'; break }
            '^`match_id`' { 'match'; break }
            '^`avatar_asset_id`' { 'asset'; break }
        }
        if ($kind) {
            $result[$kind] = $rank
        }
    }
    return $result
}

function Get-SequenceRanks {
    param(
        [string]$Text,
        [hashtable]$KindRanks
    )

    $tokenPattern = '账号团队绑定唯一键|游戏档案唯一键|房间访问会话|command result|room_team|participant session|room_session|assets?|profile|project|invitation|member|card|room|team|match|claim'
    $aliases = @{
        '账号团队绑定唯一键' = 'account-team-key'
        '游戏档案唯一键' = 'profile-key'
        '房间访问会话' = 'room-session'
        'command result' = 'command-result'
        'room_team' = 'room-team'
        'participant session' = 'room-session'
        'room_session' = 'room-session'
        'session' = 'room-session'
        'assets' = 'asset'
        'asset' = 'asset'
        'profile' = 'profile'
        'project' = 'project'
        'invitation' = 'invitation'
        'member' = 'member'
        'card' = 'card'
        'room' = 'room'
        'team' = 'team'
        'match' = 'match'
        'claim' = 'claim'
    }
    $ranks = @()
    foreach ($match in [regex]::Matches($Text, $tokenPattern, 'IgnoreCase')) {
        $kind = $aliases[$match.Value.ToLowerInvariant()]
        if (-not $KindRanks.ContainsKey($kind)) {
            throw "F-03 统一锁 rank 表缺少锁类: $kind"
        }
        $ranks += $KindRanks[$kind]
    }
    return $ranks
}

function Assert-IncreasingLockSequence {
    param(
        [string]$Label,
        [string]$Sequence,
        [hashtable]$KindRanks
    )

    $sequenceRanks = @(Get-SequenceRanks -Text $Sequence -KindRanks $KindRanks)
    for ($index = 1; $index -lt $sequenceRanks.Count; $index++) {
        if ($sequenceRanks[$index] -lt $sequenceRanks[$index - 1]) {
            throw "F-03 锁序不是全局 rank 的子序列: $Label [$Sequence]"
        }
    }
}

$kindRanks = Get-LockKindRanks -RankRows $rankSection.Groups['rows'].Value
if ($kindRanks.Count -ne 16) {
    throw "F-03 无法从统一锁 rank 表解析全部锁类，当前为 $($kindRanks.Count)"
}

$constraintSection = [regex]::Match(
    $spec,
    '(?s)## 约束与领域校验归属\s+.*?\| 不变量 \|.*?\n(?<rows>(?:\|.*\n)+)'
)
if (-not $constraintSection.Success) {
    throw 'F-03 无法解析约束与领域校验表'
}
foreach ($row in [regex]::Matches($constraintSection.Groups['rows'].Value, '(?m)^\| (?<name>.*?) \|.*?\| (?<locks>.*?) \| .*?\|$')) {
    Assert-IncreasingLockSequence -Label "不变量/$($row.Groups['name'].Value)" -Sequence $row.Groups['locks'].Value -KindRanks $kindRanks
}
foreach ($row in [regex]::Matches($matrixSection.Groups['rows'].Value, '(?m)^\| (?<name>.*?) \| (?<locks>.*?) \| .*?\|$')) {
    foreach ($variant in $row.Groups['locks'].Value -split '；') {
        Assert-IncreasingLockSequence -Label "锁矩阵/$($row.Groups['name'].Value)" -Sequence $variant -KindRanks $kindRanks
    }
}

if (-not $spec.Contains('房间访问会话')) {
    throw 'F-03 设计制品必须使用 CONTEXT.md 已定义的“房间访问会话”'
}
if ($spec.Contains('参与者会话')) {
    throw 'F-03 设计制品术语漂移: 旧词“参与者会话”应统一为“房间访问会话”'
}
if ($spec -match '(?i)participant session') {
    throw 'F-03 设计制品术语漂移: 旧词 participant session 应统一为“房间访问会话”'
}
$auditCoverage = @(
    '身份安全事件', '项目创建/改名/停用/恢复', '档案创建/修改/停用/恢复',
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

if (-not $SkipNegativeTests) {
    $negativeVariants = @(
        @{
            Name = '反序锁场景'
            Spec = $spec.Replace('team → 旧/新 member（按 ID）→ room', 'room → 旧/新 member（按 ID）→ team')
            Expected = '锁序不是全局 rank 的子序列'
        },
        @{
            Name = '遗漏项目改名审计'
            Spec = $spec.Replace('项目创建/改名/停用/恢复', '项目创建/停用/恢复')
            Expected = '审计覆盖缺少'
        },
        @{
            Name = '设计重新引入中文旧词'
            Spec = $spec + "`r`n参与者会话`r`n"
            Context = $context
            Expected = '设计制品术语漂移'
        },
        @{
            Name = '设计重新引入英文旧词'
            Spec = $spec + "`r`nparticipant session`r`n"
            Context = $context
            Expected = '设计制品术语漂移'
        },
        @{
            Name = '设计遗漏统一术语'
            Spec = $spec.Replace('房间访问会话', '访问会话')
            Context = $context
            Expected = '设计制品必须使用'
        },
        @{
            Name = 'CONTEXT 重新引入中文旧词'
            Spec = $spec
            Context = $context + "`r`n参与者会话`r`n"
            Expected = 'CONTEXT.md 术语漂移'
        },
        @{
            Name = 'CONTEXT 重新引入英文旧词'
            Spec = $spec
            Context = $context + "`r`nparticipant session`r`n"
            Expected = 'CONTEXT.md 术语漂移'
        }
    )
    foreach ($negative in $negativeVariants) {
        if (-not $negative.ContainsKey('Context')) {
            $negative.Context = $context
        }
        $temporaryPath = Join-Path ([System.IO.Path]::GetTempPath()) ("validate-f03-{0}.md" -f [guid]::NewGuid())
        $temporaryContextPath = Join-Path ([System.IO.Path]::GetTempPath()) ("validate-f03-context-{0}.md" -f [guid]::NewGuid())
        try {
            [System.IO.File]::WriteAllText(
                $temporaryPath,
                $negative.Spec,
                [System.Text.UTF8Encoding]::new($false)
            )
            [System.IO.File]::WriteAllText(
                $temporaryContextPath,
                $negative.Context,
                [System.Text.UTF8Encoding]::new($false)
            )
            $powerShellPath = (Get-Process -Id $PID).Path
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $output = & $powerShellPath -NoProfile -File $PSCommandPath -SpecPath $temporaryPath -ContextPath $temporaryContextPath -SkipNegativeTests 2>&1 | Out-String
                $negativeExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($negativeExitCode -eq 0 -or -not $output.Contains($negative.Expected)) {
                throw "F-03 破坏性负例未按预期失败: $($negative.Name)"
            }
            Write-Output "F-03 破坏性负例通过: $($negative.Name)"
        }
        finally {
            Remove-Item -LiteralPath $temporaryPath -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temporaryContextPath -ErrorAction SilentlyContinue
        }
    }
    $global:LASTEXITCODE = 0
}

Write-Output 'F-03 规范验证通过'
