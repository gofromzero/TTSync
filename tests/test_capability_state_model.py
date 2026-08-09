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

    def test_traceability_requires_mvp_10_and_story_capability_semantic_matches(self):
        self.assertIn("MVP-10", self.model["traceability"]["mvp"])
        traces = self.model["traceability"]["storyTrace"]
        room_lifecycle_trace = next(trace for trace in traces if 76 in trace["stories"])
        self.assertIn("room.create", room_lifecycle_trace["capabilities"])
        self.assertIn("room.host.transfer", room_lifecycle_trace["capabilities"])
        self.assertIn(76, self.model["capabilities"]["room.create"]["stories"])
        self.assertIn(77, self.model["capabilities"]["room.create"]["stories"])
        self.assertIn(79, self.model["capabilities"]["room.host.transfer"]["stories"])
        missing_mvp = copy.deepcopy(self.model)
        missing_mvp["traceability"]["mvp"].remove("MVP-10")
        self.assertTrue(any(
            "MVP-10" in error
            for error in self.validator.validate_model(missing_mvp)
        ))

        wrong_story = copy.deepcopy(self.model)
        wrong_story["traceability"]["storyTrace"][0]["stories"] = [76]
        errors = self.validator.validate_model(wrong_story)
        self.assertTrue(any(
            "故事 76 未命中引用 capability.stories" in error
            for error in errors
        ), errors)

        wrong_fields = copy.deepcopy(self.model)
        wrong_fields["traceability"]["storyTrace"][0]["visibleFields"] = ["roomId"]
        errors = self.validator.validate_model(wrong_fields)
        self.assertTrue(any("visibleFields 与引用 capability 不一致" in error for error in errors), errors)

        wrong_lifecycle = copy.deepcopy(self.model)
        wrong_lifecycle["traceability"]["storyTrace"][0]["lifecycleRules"] = ["open"]
        errors = self.validator.validate_model(wrong_lifecycle)
        self.assertTrue(any("lifecycleRules 与引用 capability 不一致" in error for error in errors), errors)

    def test_profile_disabled_blocks_all_game_profile_writes(self):
        for capability_id, capability in self.model["capabilities"].items():
            if capability["kind"] != "write" or not capability_id.startswith("gameProfile."):
                continue
            self.assertEqual(
                "deny",
                capability["lifecycle"]["profileDisabled"],
            )

        invalid = copy.deepcopy(self.model)
        invalid["capabilities"]["gameProfile.future.write"] = copy.deepcopy(
            invalid["capabilities"]["gameProfile.self.write"]
        )
        invalid["capabilities"]["gameProfile.future.write"]["serverCapability"] = "gameProfile.future.write"
        del invalid["capabilities"]["gameProfile.future.write"]["lifecycle"]["profileDisabled"]
        errors = self.validator.validate_model(invalid)
        self.assertTrue(any(
            "gameProfile.future.write: profileDisabled 必须为 deny" in error
            for error in errors
        ), errors)

    def test_record_creation_and_existing_record_maintenance_are_separate(self):
        create = self.model["capabilities"]["room.record.create"]
        maintain = self.model["capabilities"]["room.record.maintain"]
        self.assertEqual("deny", create["lifecycle"]["projectDisabled"])
        self.assertEqual("allow", maintain["lifecycle"]["projectDisabled"])
        self.assertNotIn("room.record.write", self.model["capabilities"])

        missing = copy.deepcopy(self.model)
        del missing["capabilities"]["room.record.maintain"]
        errors = self.validator.validate_model(missing)
        self.assertTrue(any("必须同时存在" in error for error in errors), errors)

        reversed_model = copy.deepcopy(self.model)
        reversed_model["capabilities"]["room.record.create"]["lifecycle"]["projectDisabled"] = "allow"
        reversed_model["capabilities"]["room.record.maintain"]["lifecycle"]["projectDisabled"] = "deny"
        errors = self.validator.validate_model(reversed_model)
        self.assertTrue(any("room.record.create: projectDisabled 必须为 deny" in error for error in errors), errors)
        self.assertTrue(any("room.record.maintain: projectDisabled 必须为 allow" in error for error in errors), errors)

    def test_field_visibility_schema_and_semantics_are_strict(self):
        invalid_type = copy.deepcopy(self.model)
        invalid_type["fieldVisibilityRules"]["hostOnly"] = "cards"
        errors = self.validator.validate_model(invalid_type)
        self.assertTrue(any("fieldVisibilityRules.hostOnly" in error and "类型必须为 array" in error for error in errors), errors)

        extra = copy.deepcopy(self.model)
        extra["fieldVisibilityRules"]["future"] = []
        errors = self.validator.validate_model(extra)
        self.assertTrue(any("fieldVisibilityRules" in error and "不允许字段 future" in error for error in errors), errors)

        mismatch = copy.deepcopy(self.model)
        mismatch["fieldVisibilityRules"]["hostOnly"].append("claimState")
        errors = self.validator.validate_model(mismatch)
        self.assertTrue(any("fieldVisibilityRules.hostOnly 与 capability 可见角色不一致" in error for error in errors), errors)

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
