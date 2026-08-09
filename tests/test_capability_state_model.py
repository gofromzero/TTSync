import copy
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "contracts" / "capability-state-model.json"
VALIDATOR_PATH = ROOT / "scripts" / "validate_capability_state_model.py"


class CapabilityStateModelContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("capability_model_validator", VALIDATOR_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 capability 状态模型验证入口")
        cls.validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.validator)
        cls.model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))

    def test_public_artifact_passes_all_semantic_checks(self):
        self.assertEqual([], self.validator.validate_model(self.model))

    def test_validator_rejects_client_permission_rules_and_incomplete_matrix(self):
        invalid = copy.deepcopy(self.model)
        invalid["clientPolicy"] = "derive-from-role"
        del invalid["capabilities"]["room.view"]["decisions"]["spectator"]
        errors = self.validator.validate_model(invalid)
        self.assertTrue(any("客户端必须只消费" in error for error in errors))
        self.assertTrue(any("缺少 actor 决策" in error for error in errors))

    def test_server_capabilities_are_authoritative_and_admin_takeover_is_explicit(self):
        self.assertEqual("server-authoritative", self.model["capabilityAuthority"])
        view = self.model["capabilities"]["room.view"]
        mutate = self.model["capabilities"]["room.card.create"]
        self.assertEqual("allow", view["decisions"]["teamAdminViewer"])
        self.assertEqual("deny", mutate["decisions"]["teamAdminViewer"])
        self.assertEqual("allow", mutate["decisions"]["currentHost"])
        self.assertEqual("room.host.takeover", mutate["requiresCapability"])

    def test_responsive_and_lifecycle_state_coverage_is_frozen(self):
        self.assertEqual(
            ["desktop", "320px", "390px", "520px"],
            self.model["responsive"]["viewports"],
        )
        required = {
            "loading", "empty", "connected", "recovering", "polling",
            "unreadable", "conflict", "ended", "deleted", "credentialInvalid",
        }
        for role in ("host", "participant", "spectator"):
            self.assertTrue(required.issubset(self.model["responsive"]["roles"][role]))

    def test_issue_story_range_is_traceable(self):
        required = {56, 57, 58, 67, 68, 69, 70, 71} | set(range(76, 143))
        self.assertTrue(required.issubset(self.model["traceability"]["stories"]))

    def test_schema_is_executed_and_rejects_missing_required_field(self):
        invalid = copy.deepcopy(self.model)
        del invalid["capabilities"]["room.view"]["visibleFields"]
        errors = self.validator.validate_model(invalid)
        self.assertTrue(any("visibleFields" in error and "schema" in error for error in errors))

    def test_validator_rejects_unknown_lifecycle_reference(self):
        invalid = copy.deepcopy(self.model)
        invalid["capabilities"]["room.claim"]["lifecycle"]["unknownState"] = "deny"
        errors = self.validator.validate_model(invalid)
        self.assertTrue(any("非法 lifecycle 引用" in error for error in errors))

    def test_validator_rejects_unknown_story_capability_reference(self):
        invalid = copy.deepcopy(self.model)
        invalid["traceability"]["storyTrace"][0]["capabilities"].append("room.missing")
        errors = self.validator.validate_model(invalid)
        self.assertTrue(any("无效 capability 引用" in error for error in errors))

    def test_every_traced_story_maps_to_capability_fields_and_lifecycle_rules(self):
        traces = self.model["traceability"]["storyTrace"]
        mapped = {story for trace in traces for story in trace["stories"]}
        self.assertEqual(set(self.model["traceability"]["stories"]), mapped)
        for trace in traces:
            self.assertTrue(trace["capabilities"])
            self.assertTrue(trace["visibleFields"])
            self.assertTrue(trace["lifecycleRules"])

    def test_profile_disabled_blocks_all_game_profile_writes(self):
        for capability_id in (
            "gameProfile.self.write",
            "gameProfile.admin.write",
            "gameProfile.host.write",
        ):
            self.assertEqual(
                "deny",
                self.model["capabilities"][capability_id]["lifecycle"]["profileDisabled"],
            )

    def test_record_creation_and_existing_record_maintenance_are_separate(self):
        create = self.model["capabilities"]["room.record.create"]
        maintain = self.model["capabilities"]["room.record.maintain"]
        self.assertEqual("deny", create["lifecycle"]["projectDisabled"])
        self.assertEqual("allow", maintain["lifecycle"]["projectDisabled"])
        self.assertNotIn("room.record.write", self.model["capabilities"])

    def test_realtime_transitions_reject_regression_and_automatic_replay(self):
        transitions = {item["id"]: item for item in self.model["transitions"]}
        self.assertEqual("ignore", transitions["outOfOrderNotification"]["effect"])
        self.assertEqual("discardAndRefetch", transitions["lateSnapshot"]["effect"])
        self.assertEqual("stopRealtime", transitions["terminal401"]["effect"])
        self.assertEqual("stopRealtime", transitions["terminal404"]["effect"])
        self.assertEqual("never", transitions["conflict409"]["automaticReplay"])

    def test_every_core_operation_has_accessibility_equivalent(self):
        required = {"claim", "release", "move", "withdraw", "resizeCapacity", "resolveConflict"}
        operations = {item["id"]: item for item in self.model["coreOperations"]}
        self.assertEqual(required, set(operations))
        for operation in operations.values():
            self.assertTrue(operation["keyboardPath"])
            self.assertGreaterEqual(operation["minimumTargetPx"], 44)
            self.assertTrue(operation["focusRecovery"])
            self.assertTrue(operation["nonColorAnnouncement"])


if __name__ == "__main__":
    unittest.main()
