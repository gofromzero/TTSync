#!/usr/bin/env python3
"""Validate the public F-04 capability and responsive-state artifact."""

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "contracts" / "capability-state-model.json"
SCHEMA_PATH = ROOT / "contracts" / "capability-state-model.schema.json"
ACTORS = {
    "selfMember", "teamAdminViewer", "currentHost",
    "claimingParticipant", "otherParticipant", "spectator",
}
ROLES = {"host", "participant", "spectator"}
STATES = {
    "loading", "empty", "connected", "recovering", "polling",
    "unreadable", "conflict", "ended", "deleted", "credentialInvalid",
}
TRANSITIONS = {
    "outOfOrderNotification", "lateSnapshot", "disconnectRecovery",
    "realtimeRestored", "terminal401", "terminal404", "conflict409",
}
OPERATIONS = {"claim", "release", "move", "withdraw", "resizeCapacity", "resolveConflict"}
REQUIRED_STORIES = {56, 57, 58, 67, 68, 69, 70, 71} | set(range(76, 143))


def validate_model(model):
    errors = []
    if model.get("$schema") != "./capability-state-model.schema.json":
        errors.append("模型必须引用公开 capability-state-model.schema.json")
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"无法读取公开 schema: {exc}")
    else:
        if schema.get("properties", {}).get("version", {}).get("const") != model.get("version"):
            errors.append("模型版本必须与 schema const 一致")
    if model.get("capabilityAuthority") != "server-authoritative":
        errors.append("capabilityAuthority 必须为 server-authoritative")
    if model.get("clientPolicy") != "consume-only-no-local-permission-rules":
        errors.append("客户端必须只消费服务端 capability，不得复制权限规则")

    capabilities = model.get("capabilities", {})
    if not capabilities:
        errors.append("capabilities 不能为空")
    for capability_id, capability in capabilities.items():
        missing = ACTORS - set(capability.get("decisions", {}))
        if missing:
            errors.append(f"{capability_id}: 缺少 actor 决策 {sorted(missing)}")
        if set(capability.get("decisions", {}).values()) - {"allow", "deny"}:
            errors.append(f"{capability_id}: decision 只能是 allow/deny")
        for field in ("kind", "serverCapability", "control", "visibleFields", "stories"):
            if not capability.get(field):
                errors.append(f"{capability_id}: 缺少 {field}")
        if capability.get("kind") == "write" and not capability.get("lifecycle"):
            errors.append(f"{capability_id}: 写能力缺少 lifecycle")

    traced_stories = set(model.get("traceability", {}).get("stories", []))
    missing_stories = REQUIRED_STORIES - traced_stories
    if missing_stories:
        errors.append(f"缺少 Issue #28 故事追踪 {sorted(missing_stories)}")

    responsive = model.get("responsive", {})
    if responsive.get("viewports") != ["desktop", "320px", "390px", "520px"]:
        errors.append("viewports 必须固定 desktop/320px/390px/520px")
    for role in ROLES:
        missing = STATES - set(responsive.get("roles", {}).get(role, []))
        if missing:
            errors.append(f"{role}: 缺少响应式状态 {sorted(missing)}")

    transitions = {item.get("id"): item for item in model.get("transitions", [])}
    missing = TRANSITIONS - set(transitions)
    if missing:
        errors.append(f"缺少状态迁移 {sorted(missing)}")
    if transitions.get("conflict409", {}).get("automaticReplay") != "never":
        errors.append("409 冲突不得自动重放")
    for terminal in ("terminal401", "terminal404"):
        if transitions.get(terminal, {}).get("effect") != "stopRealtime":
            errors.append(f"{terminal} 必须停止实时重连")

    operations = {item.get("id"): item for item in model.get("coreOperations", [])}
    if set(operations) != OPERATIONS:
        errors.append(f"核心操作必须恰为 {sorted(OPERATIONS)}")
    for operation_id, operation in operations.items():
        if not operation.get("keyboardPath"):
            errors.append(f"{operation_id}: 缺少非拖拽键盘路径")
        if operation.get("minimumTargetPx", 0) < 44:
            errors.append(f"{operation_id}: 触控目标小于 44px")
        if not operation.get("focusRecovery") or not operation.get("nonColorAnnouncement"):
            errors.append(f"{operation_id}: 缺少焦点恢复或非纯颜色播报")
    return errors


def main(argv=None):
    path = Path(argv[0]) if argv else DEFAULT_MODEL
    try:
        model = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL {path}: {exc}", file=sys.stderr)
        return 1
    errors = validate_model(model)
    if errors:
        for error in errors:
            print(f"FAIL {error}", file=sys.stderr)
        return 1
    print(f"PASS {path.relative_to(ROOT)}: capability/state model is complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
