import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

import test_session_listening_pass as session_fixtures  # noqa: E402
from AbletonAgent.errors import ProtocolFailure  # noqa: E402


class FakeControlSurface:
    def __init__(self, host):
        self.host = host

    def application(self):
        return self.host.application

    def song(self):
        return self.host.song

    def schedule_message(self, ticks, callback):
        self.host.schedule_message(ticks, callback)

    def log_message(self, message):
        self.host.logs.append(message)

    def disconnect(self):
        self.host.base_disconnected = True


class ControlSurfaceCleanupTest(unittest.TestCase):
    def setUp(self):
        self.fixture = session_fixtures.SessionListeningPassTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        framework = types.ModuleType("_Framework")
        control_surface = types.ModuleType("_Framework.ControlSurface")
        control_surface.ControlSurface = FakeControlSurface
        path = Path(__file__).resolve().parents[1] / "AbletonAgent" / "control_surface.py"
        spec = importlib.util.spec_from_file_location("AbletonAgent._cleanup_test", path)
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            "_Framework": framework, "_Framework.ControlSurface": control_surface,
        }):
            spec.loader.exec_module(self.module)
        self.host = types.SimpleNamespace(
            application=Mock(), song=self.fixture.song, logs=[], base_disconnected=False,
            schedule_message=self.fixture.context.schedule_message,
        )
        self.server, self.subscriptions = Mock(), Mock()
        self.executor, self.listeners, self.save_observer = Mock(), Mock(), Mock()
        with patch.multiple(
            self.module,
            LomSubscriptionManager=Mock(return_value=self.subscriptions),
            MainThreadExecutor=Mock(return_value=self.executor),
            RemoteScriptServer=Mock(return_value=self.server),
            LomListenerManager=Mock(return_value=self.listeners),
            LiveSetSaveObserver=Mock(return_value=self.save_observer),
            build_capability_document=Mock(return_value={}),
            load_or_create_token=Mock(return_value="test-only-token"),
            register_system_commands=Mock(),
            register_event_commands=Mock(),
        ):
            self.surface = self.module.AbletonAgentControlSurface(self.host)
            self.client_disconnect = self.module.RemoteScriptServer.call_args.kwargs["on_client_disconnect"]
        self.surface._runtime_context = self.fixture.context

    def test_client_disconnect_schedules_main_thread_cleanup_and_fences_deferred_fire(self):
        self.fixture.call()
        launch = self.fixture.call("launch")
        self.client_disconnect()
        self.assertIsNotNone(self.fixture.context._session_listening_pass)
        self.subscriptions.clear.assert_not_called()
        self.fixture.tick()
        self.assertIsNone(self.fixture.context._session_listening_pass)
        self.subscriptions.clear.assert_called_once_with()
        results, errors = [], []
        launch.start(results.append, errors.append)
        self.fixture.tick()
        self.assertEqual(errors, [])
        self.assertEqual(results[0]["mutationState"], "not-attempted")
        self.assertEqual(self.fixture.fires, 0)
        self.fixture.assert_no_monitors()

    def test_client_disconnect_after_dispatch_leaves_host_queue_and_playback_unchanged(self):
        self.fixture.call()
        self.fixture.launch()
        self.client_disconnect()
        self.fixture.tick()
        self.assertEqual(self.fixture.fires, 1)
        self.assertTrue(self.fixture.song.is_playing)
        self.assertEqual(self.fixture.results[0]["mutationState"], "indeterminate")
        self.assertEqual(self.fixture.results[0]["cleanupPolicy"], "leave-running")
        self.fixture.assert_no_monitors()
        self.surface.disconnect()
        self.assertTrue(self.host.base_disconnected)
        self.fixture.assert_no_monitors()

    def test_shutdown_clears_pass_before_executor_close_and_never_stops_playback(self):
        self.fixture.call()
        self.fixture.launch()
        order = []
        self.executor.close.side_effect = lambda: order.append(
            self.fixture.context._session_listening_pass is None,
        )
        self.surface.disconnect()
        self.assertEqual(order, [True])
        self.assertTrue(self.fixture.song.is_playing)
        self.assertEqual(self.fixture.fires, 1)
        self.assertTrue(self.host.base_disconnected)
        for component in (self.save_observer, self.subscriptions, self.listeners, self.server):
            component.stop.assert_called_once_with()
        self.executor.close.assert_called_once_with()
        self.fixture.assert_no_monitors()

    def test_shutdown_fences_launch_that_has_not_been_dispatched(self):
        self.fixture.call()
        launch = self.fixture.call("launch")
        self.surface.disconnect()
        results, errors = [], []
        launch.start(results.append, errors.append)
        self.assertEqual(errors, [])
        self.assertEqual(self.fixture.fires, 0)
        self.assertEqual(results[0]["status"], "cancelled")
        self.fixture.assert_no_monitors()

    def test_session_cleanup_failure_does_not_skip_other_disconnect_cleanup(self):
        self.fixture.call()
        active = self.fixture.context._session_listening_pass
        remove = active.registrations[-1]
        active.registrations[-1] = (
            remove[0], remove[1], Mock(side_effect=RuntimeError("remove failed")), remove[3],
        )
        self.client_disconnect()
        with self.assertRaises(ProtocolFailure):
            self.fixture.tick()
        self.subscriptions.clear.assert_called_once_with()
        with self.assertRaises(ProtocolFailure):
            self.surface.disconnect()
        self.executor.close.assert_called_once_with()
        self.server.stop.assert_called_once_with()
        self.assertTrue(self.host.base_disconnected)
        active.registrations[-1] = remove
        self.module.clear_session_listening_pass(self.fixture.context)
        self.fixture.assert_no_monitors()

    def test_workflow_shutdown_failure_does_not_skip_source_pass_or_executor_cleanup(self):
        self.fixture.call()
        manager = Mock()
        manager.mark_running_indeterminate.side_effect = RuntimeError("job cleanup failed")
        self.fixture.context._workflow_job_manager = manager
        with self.assertRaisesRegex(RuntimeError, "job cleanup failed"):
            self.surface.disconnect()
        self.assertIsNone(self.fixture.context._session_listening_pass)
        self.executor.close.assert_called_once_with()
        self.server.stop.assert_called_once_with()
        self.assertTrue(self.host.base_disconnected)
        self.fixture.assert_no_monitors()
