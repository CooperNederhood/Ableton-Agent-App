"""Logical property-observation countermodels, NOT actual Live validation."""

import json
import os
import unittest


class PropertyOnlyHost(object):
    """An implementation permitted by a value-change observation contract."""

    def __init__(self):
        self.state = {"current_song_time": 8.0, "is_playing": True, "loop": False}
        self.callbacks = []
        self.actions = []

    def advance(self, beats):
        self.actions.append("natural_advance")
        self.value_change("current_song_time", self.state["current_song_time"] + beats)

    def seek(self, beat):
        self.actions.append("external_seek")
        self.value_change("current_song_time", beat)

    def retrigger(self):
        self.actions.append("external_retrigger")
        self.value_change("is_playing", True)

    def value_change(self, name, value):
        if self.state[name] != value:
            self.state[name] = value
            # No action origin or host-owned mutation generation is supplied.
            self.callbacks.append((name, value))

    def snapshot(self):
        return dict(self.state)


class ArrangementOwnershipEvidenceTests(unittest.TestCase):
    def test_forward_seek_and_natural_advance_have_identical_value_evidence(self):
        natural, external = PropertyOnlyHost(), PropertyOnlyHost()
        natural.advance(0.125)
        external.seek(8.125)
        self.assertNotEqual(natural.actions, external.actions)
        self.assertEqual(natural.callbacks, external.callbacks)
        self.assertEqual(natural.snapshot(), external.snapshot())

    def test_same_value_seek_and_retrigger_need_not_notify(self):
        idle, external = PropertyOnlyHost(), PropertyOnlyHost()
        external.seek(8.0)
        external.retrigger()
        self.assertNotEqual(idle.actions, external.actions)
        self.assertEqual(idle.callbacks, external.callbacks)
        self.assertEqual(idle.snapshot(), external.snapshot())

    def test_polling_misses_stop_start_and_loop_takeover(self):
        baseline, external = PropertyOnlyHost(), PropertyOnlyHost()
        external.value_change("is_playing", False)
        external.value_change("is_playing", True)
        external.value_change("loop", True)
        external.value_change("loop", False)
        self.assertEqual(baseline.snapshot(), external.snapshot())
        self.assertNotEqual(baseline.callbacks, external.callbacks)

    def test_lossless_discrete_callback_latch_cannot_recover_from_takeover(self):
        host = PropertyOnlyHost()
        host.value_change("is_playing", False)
        host.value_change("is_playing", True)
        # Conditional on callbacks arriving before protected mutation, not a
        # claim that the actual host provides this delivery guarantee.
        lost = any(name == "is_playing" for name, _value in host.callbacks)
        self.assertTrue(lost)
        self.assertTrue(host.state["is_playing"])

    def test_spec_is_bounded_nonpublishing_and_preserves_native_authority_gap(self):
        path = os.path.join(os.path.dirname(__file__), "..", "validation",
                            "arrangement-ownership-experiment.json")
        with open(path) as source:
            spec = json.load(source)
        self.assertEqual(spec["status"], "specification_only_not_executable_or_certification")
        ids = [case["id"] for case in spec["cases"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertLessEqual(len(ids), spec["runner"]["budgets"]["cases"])
        self.assertIn("seek-same", ids)
        self.assertIn("retrigger", ids)
        self.assertIn("stop-start", ids)
        self.assertIn("source-override", ids)
        self.assertIn("record-flags", ids)
        self.assertIn("loop", ids)
        self.assertIn("capability remains disabled", spec["cases"][-1]["assert"])
        self.assertIn("Host-native authority", spec["minimumApiChange"]["authority"])


if __name__ == "__main__":
    unittest.main()
