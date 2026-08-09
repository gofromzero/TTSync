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


def require(text: str, pattern: str, label: str, failures: list[str]) -> None:
    if re.search(pattern, text, re.MULTILINE | re.DOTALL) is None:
        failures.append(f"缺少 {label}: /{pattern}/")


def forbid(text: str, pattern: str, label: str, failures: list[str]) -> None:
    if re.search(pattern, text, re.MULTILINE | re.IGNORECASE):
        failures.append(f"出现禁用模式 {label}: /{pattern}/")


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

    for scenario in ("邀请接受", "主持资格保护", "管理员接管", "访客归属", "头像引用切换"):
        require(spec, rf"^### {scenario}$", f"场景 {scenario}", failures)
        require(
            spec,
            rf"^### {scenario}$.*?\*\*事务发起者\*\*.*?\*\*规则所有者\*\*.*?\*\*稳定失败\*\*.*?\*\*统一回滚\*\*",
            f"{scenario} 的事务、规则、失败和回滚",
            failures,
        )

    for term in ("账号", "成员", "登录会话", "参与者会话", "认领", "团队", "队伍", "房间快照", "对局快照"):
        require(spec, re.escape(term), f"分离术语 {term}", failures)
        require(context, rf"^\*\*{re.escape(term)}\*\*:", f"CONTEXT.md 术语 {term}", failures)

    ownership_rows = {
        "identity": "账号、密码、邮箱状态、验证／恢复令牌、登录会话",
        "team": "团队、团队管理员、成员、账号绑定、邀请、游戏项目、游戏档案、记录模板、成员修订号、成员与游戏档案的长期头像引用",
        "activity": "房间、主持权、参与者会话、观众会话、人员牌、访客牌、认领、队伍、容量、对局记录、房间修订号、房间快照、对局快照、房间内头像引用",
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

    require(
        spec,
        r"### `team` Module.*?\| 重新鉴权 \|[^\n]*`identity` Interface[^\n]*账号验证",
        "team 通过 identity Interface 重新鉴权",
        failures,
    )
    forbid(
        spec,
        r"### `team` Module.*?\| 重新鉴权 \|[^\n]*(自行|直接|重新读取)[^\n]*账号验证",
        "team 越权读取 identity 账号验证状态",
        failures,
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

    forbid(spec, r"\b(Create|Get|List|Update|Delete)(Account|Member|Room|Record|Team|Profile)s?\b", "表级 CRUD Interface", failures)
    forbid(spec, r"Chi[^\n]*(判断|决定|拥有)[^\n]*(权限|资格)", "Chi 判断领域权限", failures)
    forbid(spec, r"reporting[^\n]*(写入|回写|修改)[^\n]*(状态|领域)", "reporting 回写", failures)
    forbid(spec, r"模块[^\n]*(自行|私自)[^\n]*提交", "模块私自提交共享事务", failures)
    forbid(context, r"\b(Interface|Adapter|PostgreSQL|Chi)\b", "CONTEXT.md 实现术语", failures)

    if failures:
        print("模块 seam 规范校验失败：")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1

    print("模块 seam 规范校验通过：术语、交叉引用、必需场景与禁用模式均满足。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
