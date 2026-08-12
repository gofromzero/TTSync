#!/usr/bin/env python3
"""Validate the frozen module ownership and shared-transaction specification."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "design" / "module-seams.md"
ADR = ROOT / "docs" / "adr" / "0001-shared-postgresql-work-unit.md"
CONTEXT = ROOT / "CONTEXT.md"

EXPECTED_MVP_STORIES = {
    "MVP-01": set(range(1, 22)),
    "MVP-02": set(range(7, 20)) | set(range(22, 31)),
    "MVP-03": set(range(45, 63)),
    "MVP-04": set(range(76, 93)),
    "MVP-05": set(range(93, 108)),
    "MVP-06": set(range(108, 121)),
    "MVP-07": set(range(31, 45)),
    "MVP-08": set(range(121, 129)),
    "MVP-09": set(range(129, 143)),
    "MVP-10": set(range(143, 154)),
    "MVP-11": set(range(63, 76)),
}
MODULES = {"identity", "team", "activity", "reporting"}
ACTIVITY_COMMAND_ORDER = (
    "解析 `commandId`",
    "核对操作者并拒绝复用冲突",
    "核对请求指纹并拒绝复用冲突",
    "命中相同幂等键时返回首次已提交成功结果",
    "校验 `expectedRevision`",
    "重新鉴权身份与权限",
    "校验领域规则",
    "判断语义是否改变",
    "写入状态",
    "递增 revision",
    "登记 `NOTIFY`",
    "记录命令结果",
    "由该深 Module 提交；若该命令处于真正的跨 Module 原子用例，则改由最外层用例协调者统一提交",
)
EXPECTED_MVP_MODULES = {
    "MVP-01": {"identity", "team"},
    "MVP-02": {"identity", "team"},
    "MVP-03": {"team"},
    "MVP-04": {"identity", "team", "activity"},
    "MVP-05": {"activity"},
    "MVP-06": {"activity"},
    "MVP-07": {"identity", "team", "activity"},
    "MVP-08": {"identity", "team", "activity"},
    "MVP-09": {"activity"},
    "MVP-10": {"identity", "team", "reporting"},
    "MVP-11": {"team", "activity"},
}
EXPECTED_SEAM_TOKENS = {
    "MVP-01": ("`identity`", "`team`", "共享工作单元 seam"),
    "MVP-02": ("`identity`", "`team`", "共享工作单元 seam"),
    "MVP-03": ("`team` Interface seam",),
    "MVP-04": ("`identity`", "`team`", "`activity`", "共享工作单元 seam"),
    "MVP-05": ("`activity` Interface seam",),
    "MVP-06": ("`activity` Interface seam",),
    "MVP-07": ("`identity`", "`team`", "`activity`", "共享工作单元 seam"),
    "MVP-08": ("`identity`", "`team`", "`activity`", "共享工作单元 seam"),
    "MVP-09": ("`activity`", "真实浏览器", "Caddy", "真实 PostgreSQL"),
    "MVP-10": ("`identity`", "`team`", "`reporting`", "一致只读工作单元 seam", "浏览器下载"),
    "MVP-11": ("`team`", "`activity`", "files Adapter", "真实 PostgreSQL", "浏览器", "恢复 seam"),
}
EXPECTED_NEGATIVE_CONTROL_COUNTS = {
    "cross_module": 1,
    "team_reauthentication": 1,
    "activity_contract": 7,
    "activity_order_deletion": len(ACTIVITY_COMMAND_ORDER),
    "activity_order_swap": len(ACTIVITY_COMMAND_ORDER) - 1,
    "activity_rollback": 1,
    "activity_forbidden_result": 3,
}


def require(text: str, pattern: str, label: str, failures: list[str]) -> None:
    if re.search(pattern, text, re.MULTILINE | re.DOTALL) is None:
        failures.append(f"缺少 {label}: /{pattern}/")


def forbid(text: str, pattern: str, label: str, failures: list[str]) -> None:
    if re.search(pattern, text, re.MULTILINE | re.DOTALL | re.IGNORECASE):
        failures.append(f"出现禁用模式 {label}: /{pattern}/")


def section_under_h3(text: str, heading: str) -> str:
    """Return one exact level-three section, excluding following peers."""
    match = re.search(
        rf"^{re.escape(heading)}$.*?(?=^### |\Z)",
        text,
        re.MULTILINE | re.DOTALL,
    )
    return match.group(0) if match else ""


def validate_cross_module_scenarios(spec: str, failures: list[str]) -> None:
    fields = ("事务发起者", "规则所有者", "稳定失败", "统一回滚")
    for scenario in ("邀请接受", "主持资格保护", "管理员接管", "访客归属", "头像引用切换"):
        section = section_under_h3(spec, f"### {scenario}")
        if not section:
            failures.append(f"缺少 场景 {scenario}")
            continue
        positions = []
        for field in fields:
            marker = f"**{field}**"
            position = section.find(marker)
            if position < 0:
                failures.append(f"{scenario} 场景缺少字段 {field}")
            positions.append(position)
        if all(position >= 0 for position in positions) and positions != sorted(positions):
            failures.append(f"{scenario} 场景字段顺序错误")


def validate_team_reauthentication(spec: str, failures: list[str]) -> None:
    section = section_under_h3(spec, "### `team` Module")
    require(
        section,
        r"\| 重新鉴权 \|[^\n]*`identity` Interface[^\n]*账号验证",
        "team 通过 identity Interface 重新鉴权",
        failures,
    )
    forbid(
        section,
        r"\| 重新鉴权 \|.*?(?:不得自行|不得直接|不得重新读取).*?账号验证(?:状态)?",
        "team 越权读取 identity 账号验证状态",
        failures,
    )


def validate_activity_command_contract(spec: str, failures: list[str]) -> None:
    section = section_under_h3(spec, "### `activity` Module")
    requirements = (
        (r"相同 `commandId`、操作者和请求指纹", "activity 幂等键"),
        (r"请求指纹[^\n]*payload[^\n]*`expectedRevision`", "activity 请求指纹范围"),
        (r"重放[^\n]*首次成功结果", "activity 幂等重试结果"),
        (r"同一 `commandId`[^\n]*(?:换|不同)操作者[^\n]*`command_reuse_conflict`", "activity 换操作者冲突"),
        (r"同一 `commandId`[^\n]*(?:换|不同)请求指纹[^\n]*`command_reuse_conflict`", "activity 换请求指纹冲突"),
        (r"旧[^\n]*`expectedRevision`[^\n]*优先[^\n]*语义 no-op[^\n]*`revision_conflict`", "activity 旧 revision 优先"),
        (r"合法[^\n]*no-op[^\n]*`changed: false`", "activity 合法 no-op 结果"),
        (r"`changed: false`[^\n]*不递增[^\n]*revision[^\n]*不[^\n]*`NOTIFY`", "activity no-op 无副作用"),
        (r"只有已提交成功命令[^\n]*`commandId`[^\n]*操作者[^\n]*请求指纹[^\n]*重放[^\n]*首次成功结果", "activity 只重放已提交成功结果"),
        (r"失败[^\n]*整体回滚[^\n]*命令结果[^\n]*占位[^\n]*不持久化", "activity 失败不持久化结果或占位"),
        (r"失败[^\n]*后续重试[^\n]*重新[^\n]*鉴权[^\n]*版本[^\n]*领域规则", "activity 失败重试重新判定"),
        (r"没有已提交成功[^\n]*ledger[^\n]*不[^\n]*`command_reuse_conflict`", "activity 无成功 ledger 不制造复用冲突"),
    )
    for pattern, label in requirements:
        require(section, pattern, label, failures)

    order_match = re.search(r"完整判定顺序为：([^\n]+)", section)
    actual_order = tuple(
        step.strip().rstrip("。") for step in order_match.group(1).split("→")
    ) if order_match else ()
    if actual_order != ACTIVITY_COMMAND_ORDER:
        failures.append(
            "activity 完整判定顺序错误: "
            f"期望 {list(ACTIVITY_COMMAND_ORDER)}，实际 {list(actual_order)}"
        )
    require(
        section,
        r"(?:任一步|任何)失败[^\n]*(?:应用编排[^\n]*统一回滚|整体回滚)[^\n]*命令结果[^\n]*不持久化",
        "activity 失败统一回滚且不记录结果",
        failures,
    )
    for pattern, label in (
        (r"失败[^\n]*(?:结果)?重放|重放[^\n]*失败(?:结果)?", "activity 重放失败结果"),
        (r"(?:记录|持久化)失败(?:结果|命令结果|\s*ledger)|失败(?:结果|命令结果|\s*ledger)(?:被)?(?:记录|持久化)", "activity 记录失败 ledger"),
        (r"失败[^\n]*(?:保留|持久化)[^\n]*(?:占位|placeholder)", "activity 失败后保留占位"),
    ):
        forbid(section, pattern, label, failures)


def assert_negative_controls(spec: str, failures: list[str]) -> dict[str, int]:
    counts = {group: 0 for group in EXPECTED_NEGATIVE_CONTROL_COUNTS}
    scenario = section_under_h3(spec, "### 管理员接管")
    mutated = spec.replace(scenario, scenario.replace("**稳定失败**", "**失败**", 1), 1)
    observed: list[str] = []
    counts["cross_module"] += 1
    validate_cross_module_scenarios(mutated, observed)
    if "管理员接管 场景缺少字段 稳定失败" not in observed:
        failures.append("负例失效：删除中间场景字段未被拒绝")

    team = section_under_h3(spec, "### `team` Module")
    violation = team + "\n不得自行跨行\n重新读取账号验证状态。\n"
    observed = []
    counts["team_reauthentication"] += 1
    validate_team_reauthentication(spec.replace(team, violation, 1), observed)
    if not any("team 越权读取" in failure for failure in observed):
        failures.append("负例失效：team 跨行越权措辞未被拒绝")

    activity = section_under_h3(spec, "### `activity` Module")
    for token, label in (
        ("请求指纹包含类型化 payload 与 `expectedRevision`", "请求指纹范围"),
        ("旧 `expectedRevision` 的拒绝优先于语义 no-op", "旧 revision 优先"),
        ("不递增 revision 且不登记 `NOTIFY`", "no-op 无副作用"),
        ("只有已提交成功命令", "只重放已提交成功结果"),
        ("命令结果与占位均不持久化", "失败不持久化结果或占位"),
        ("后续重试重新走鉴权、版本与领域规则", "失败重试重新判定"),
        (
            "没有已提交成功的 ledger 时不以旧失败制造 `command_reuse_conflict`",
            "无成功 ledger 不制造复用冲突",
        ),
    ):
        if token not in activity:
            failures.append(f"负例失效：缺少 activity {label} 变异锚点")
            continue
        observed = []
        counts["activity_contract"] += 1
        validate_activity_command_contract(spec.replace(token, "", 1), observed)
        if not any(label in failure for failure in observed):
            failures.append(f"负例失效：删除 activity {label} 未被拒绝")

    order_text = " → ".join(ACTIVITY_COMMAND_ORDER)
    if order_text in activity:
        for index, step in enumerate(ACTIVITY_COMMAND_ORDER):
            mutated_steps = list(ACTIVITY_COMMAND_ORDER)
            mutated_steps.pop(index)
            observed = []
            counts["activity_order_deletion"] += 1
            validate_activity_command_contract(
                spec.replace(order_text, " → ".join(mutated_steps), 1), observed
            )
            if not any("activity 完整判定顺序错误" in failure for failure in observed):
                failures.append(f"负例失效：删除 activity 判定步骤 {step} 未被拒绝")

        for index in range(len(ACTIVITY_COMMAND_ORDER) - 1):
            mutated_steps = list(ACTIVITY_COMMAND_ORDER)
            mutated_steps[index], mutated_steps[index + 1] = (
                mutated_steps[index + 1],
                mutated_steps[index],
            )
            observed = []
            counts["activity_order_swap"] += 1
            validate_activity_command_contract(
                spec.replace(order_text, " → ".join(mutated_steps), 1), observed
            )
            if not any("activity 完整判定顺序错误" in failure for failure in observed):
                failures.append(
                    f"负例失效：交换 activity 判定步骤 {index + 1}/{index + 2} 未被拒绝"
                )
    else:
        failures.append("负例失效：缺少 activity 完整判定顺序变异锚点")

    rollback = "任何失败均整体回滚，命令结果与占位均不持久化"
    if rollback not in activity:
        failures.append("负例失效：缺少 activity 统一回滚约束变异锚点")
    else:
        observed = []
        counts["activity_rollback"] += 1
        validate_activity_command_contract(spec.replace(rollback, "", 1), observed)
        if not any(
            "activity 失败统一回滚且不记录结果" in failure
            for failure in observed
        ):
            failures.append("负例失效：删除 activity 统一回滚约束未被拒绝")

    for violation, label in (
        ("失败结果重放。", "activity 重放失败结果"),
        ("记录失败 ledger。", "activity 记录失败 ledger"),
        ("失败后保留占位。", "activity 失败后保留占位"),
    ):
        observed = []
        counts["activity_forbidden_result"] += 1
        validate_activity_command_contract(
            spec.replace(activity, activity + "\n" + violation, 1), observed
        )
        if not any(label in failure for failure in observed):
            failures.append(f"负例失效：{label} 未被拒绝")

    if counts != EXPECTED_NEGATIVE_CONTROL_COUNTS:
        failures.append(
            "负例执行数量错误: "
            f"期望 {EXPECTED_NEGATIVE_CONTROL_COUNTS}，实际 {counts}"
        )
    return counts


def parse_story_ranges(value: str) -> set[int]:
    stories: set[int] = set()
    for part in (item.strip() for item in value.split("、")):
        match = re.fullmatch(r"(\d+)(?:[–-](\d+))?", part)
        if match is None:
            raise ValueError(part)
        start = int(match.group(1))
        end = int(match.group(2) or start)
        if end < start:
            raise ValueError(part)
        stories.update(range(start, end + 1))
    return stories


def validate_coverage_matrix(spec: str, failures: list[str]) -> None:
    heading = "## MVP、故事与 Module／seam 追踪"
    start = spec.find(heading)
    end = spec.find("\n## ", start + len(heading)) if start >= 0 else -1
    section = spec[start:end if end >= 0 else len(spec)] if start >= 0 else ""
    rows = re.findall(
        r"^\| (MVP-\d{2}) \| ([\d、–-]+) \| ([a-z、]+) \| ([^|]+) \|$",
        section,
        re.MULTILINE,
    )
    parsed: dict[str, tuple[set[int], set[str], str]] = {}
    for mvp, story_text, module_text, seam_text in rows:
        try:
            stories = parse_story_ranges(story_text)
        except ValueError:
            failures.append(f"{mvp} 故事范围不可解析: {story_text}")
            continue
        modules = set(module_text.split("、"))
        if not modules or not modules <= MODULES:
            failures.append(f"{mvp} 包含未知 Module: {module_text}")
        if "seam" not in seam_text.lower() or not seam_text.strip():
            failures.append(f"{mvp} 缺少可定位 seam: {seam_text.strip()}")
        if mvp in parsed:
            failures.append(f"{mvp} 重复映射")
        parsed[mvp] = (stories, modules, seam_text.strip())

    if set(parsed) != set(EXPECTED_MVP_STORIES):
        failures.append(
            "MVP 映射不完整: "
            f"期望 {sorted(EXPECTED_MVP_STORIES)}，实际 {sorted(parsed)}"
        )
    for mvp, expected_stories in EXPECTED_MVP_STORIES.items():
        if mvp in parsed and parsed[mvp][0] != expected_stories:
            failures.append(
                f"{mvp} 故事映射错误: "
                f"期望 {sorted(expected_stories)}，实际 {sorted(parsed[mvp][0])}"
            )
        if mvp in parsed and parsed[mvp][1] != EXPECTED_MVP_MODULES[mvp]:
            failures.append(
                f"{mvp} Module 映射错误: "
                f"期望 {sorted(EXPECTED_MVP_MODULES[mvp])}，实际 {sorted(parsed[mvp][1])}"
            )
        if mvp in parsed:
            missing_tokens = [
                token for token in EXPECTED_SEAM_TOKENS[mvp]
                if token not in parsed[mvp][2]
            ]
            if missing_tokens:
                failures.append(f"{mvp} seam 映射缺少: {missing_tokens}")
    covered = set().union(*(stories for stories, _, _ in parsed.values())) if parsed else set()
    if covered != set(range(1, 154)):
        failures.append("故事 1–153 未被 MVP-01..11 完整映射")


def main() -> int:
    failures: list[str] = []
    for path in (SPEC, ADR, CONTEXT):
        if not path.is_file():
            failures.append(f"缺少文件: {path.relative_to(ROOT)}")

    if failures:
        print("模块 seam 规范校验失败：")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1

    spec = SPEC.read_text(encoding="utf-8")
    adr = ADR.read_text(encoding="utf-8")
    context = CONTEXT.read_text(encoding="utf-8")

    modules = ("identity", "team", "activity", "reporting")
    interface_facts = ("目标", "输入", "结果", "稳定失败", "重新鉴权", "事务参与")
    for index, module in enumerate(modules):
        heading = f"### `{module}` Module"
        require(spec, rf"^{re.escape(heading)}$", f"{module} Module", failures)
        start = spec.find(heading)
        next_start = spec.find("### `", start + len(heading)) if index < len(modules) - 1 else spec.find("## 共享", start)
        section = spec[start:next_start] if start >= 0 and next_start > start else ""
        for interface_fact in interface_facts:
            require(section, rf"\| {interface_fact} \|", f"{module} Interface 字段 {interface_fact}", failures)

    validate_cross_module_scenarios(spec, failures)

    for source_name, source in (("模块 seam", spec), ("CONTEXT.md", context)):
        for deprecated in ("参与者会话", "participant session"):
            if deprecated.lower() in source.lower():
                failures.append(f"{source_name} 使用旧词 {deprecated}，应统一为房间访问会话")

    for term in ("账号", "成员", "登录会话", "房间访问会话", "认领", "团队", "队伍", "房间快照", "对局快照"):
        require(spec, re.escape(term), f"分离术语 {term}", failures)
        require(context, rf"^\*\*{re.escape(term)}\*\*:", f"CONTEXT.md 术语 {term}", failures)

    ownership_rows = {
        "identity": "账号、密码、邮箱状态、验证／恢复令牌、登录会话",
        "team": "团队、团队管理员、成员、账号绑定、邀请、游戏项目、游戏档案、记录模板、成员修订号、成员与游戏档案的长期头像引用",
        "activity": "房间、主持权、房间访问会话、观众会话、人员牌、访客牌、认领、队伍、容量、对局记录、房间修订号、房间快照、对局快照、房间内头像引用",
        "reporting": "历史查询、基础统计、六表 CSV 导出的只读模型",
    }
    for owner, facts in ownership_rows.items():
        require(spec, rf"\| {re.escape(facts)} \| `{owner}` \|", f"{owner} 唯一写所有者", failures)

    validate_coverage_matrix(spec, failures)

    require(
        spec,
        r"\| 头像资产元数据、可用性、恢复期、GC 状态 \| `team` \|",
        "头像资产领域事实的唯一写所有者",
        failures,
    )
    require(
        spec,
        r"### `team` Module.*?\| 目标 \|[^\n]*头像资产元数据[^\n]*可用性[^\n]*恢复期[^\n]*GC",
        "team Interface 的头像资产生命周期目标",
        failures,
    )
    require(
        spec,
        r"`files` Adapter[^\n]*(只|仅)[^\n]*字节",
        "files Adapter 仅负责字节适配",
        failures,
    )

    validate_team_reauthentication(spec, failures)
    validate_activity_command_contract(spec, failures)
    negative_control_counts = assert_negative_controls(spec, failures)
    print(
        "负例变异执行："
        f"总数 {sum(negative_control_counts.values())}，分组 {negative_control_counts}"
    )
    require(spec, r"### `team` Module.*?\| 稳定失败 \|[^\n]*`binding_conflict`", "team 稳定失败 binding_conflict", failures)
    require(spec, r"### `team` Module.*?\| 稳定失败 \|[^\n]*`profile_conflict`", "team 稳定失败 profile_conflict", failures)
    require(context, r"^\*\*观众会话\*\*:", "CONTEXT.md 术语 观众会话", failures)

    for adapter in ("Chi", "PostgreSQL", "files", "mail", "clock"):
        require(spec, rf"`{adapter}` Adapter", f"{adapter} Adapter", failures)

    require(spec, r"GitHub Issue #24", "父规格交叉引用", failures)
    require(spec, r"GitHub Issue #26", "本票交叉引用", failures)
    require(spec, r"MVP-01～MVP-11", "MVP 覆盖", failures)
    require(spec, r"故事 1～153", "故事覆盖", failures)
    require(adr, r"共享 PostgreSQL 工作单元", "共享工作单元 ADR", failures)
    require(spec, r"单一所有者的深 Module 写命令自行开启并完成 PostgreSQL 事务", "深 Module 自持单一所有者命令事务", failures)
    require(spec, r"事务、锁、权限和领域不变量不外泄给 HTTP Adapter、\`internal/app\` 组装层", "HTTP 与 app 不持有业务事务", failures)
    require(adr, r"只有必须原子改变[^\n]*多个所有权事实[^\n]*最外层用例协调者建立共享工作单元", "ADR 仅为跨 Module 用例共享事务", failures)

    forbid(spec, r"\b(Create|Get|List|Update|Delete)(Account|Member|Room|Record|Team|Profile)s?\b", "表级 CRUD Interface", failures)
    forbid(spec, r"Chi[^\n]*(判断|决定|拥有)[^\n]*(权限|资格)", "Chi 判断领域权限", failures)
    forbid(spec, r"reporting[^\n]*(写入|回写|修改)[^\n]*(状态|领域)", "reporting 回写", failures)
    forbid(spec, r"共享[^\n]*Module[^\n]*(自行|私自)[^\n]*提交", "模块私自提交共享事务", failures)
    forbid(context, r"\b(Interface|Adapter|PostgreSQL|Chi)\b", "CONTEXT.md 实现术语", failures)

    if failures:
        print("模块 seam 规范校验失败：")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1

    print("模块 seam 规范校验通过：术语、交叉引用、必需场景与禁用模式均满足。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
