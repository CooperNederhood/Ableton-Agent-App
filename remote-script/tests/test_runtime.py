import os
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.capabilities import build_capability_document  # noqa: E402
from AbletonAgent.executor import MainThreadExecutor  # noqa: E402
from AbletonAgent.messages import PROTOCOL_VERSION, success  # noqa: E402
from AbletonAgent.protocol import FrameDecoder, encode_frame  # noqa: E402
from AbletonAgent.registry import CommandRegistry  # noqa: E402
from AbletonAgent.server import LOOPBACK_HOST, RemoteScriptServer  # noqa: E402
from AbletonAgent.system_commands import register_system_commands  # noqa: E402
from AbletonAgent.token_store import load_or_create_token  # noqa: E402


def request(command, params=None):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "requestId": str(uuid.uuid4()),
        "command": command,
        "params": params or {},
    }


class FakeTrack(object):
    def __init__(self, name, midi=True, group=False):
        self.name = name
        self.has_midi_input = midi
        self.is_foldable = group
        self.can_be_armed = not group
        self.color = 10
        self.mute = False
        self.solo = False
        self.arm = True
        self.mixer_device = FakeMixerDevice()


class FakeParameter(object):
    def __init__(self, value):
        self.value = value


class FakeMixerDevice(object):
    def __init__(self):
        self.volume = FakeParameter(0.8)
        self.panning = FakeParameter(0.0)


class FakeSong(object):
    def __init__(self):
        self.tempo = 124.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.is_playing = True
        self.file_path = "/tmp/example.als"
        self.tracks = [FakeTrack("Drums"), FakeTrack("Bass")]

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def create_midi_track(self, index):
        self.tracks.insert(index, FakeTrack("MIDI", midi=True))

    def create_audio_track(self, index):
        self.tracks.insert(index, FakeTrack("Audio", midi=False))

    def delete_track(self, index):
        del self.tracks[index]


class FakeApplication(object):
    def get_version_string(self):
        return "12.1-test"


class FakeContext(object):
    def __init__(self):
        self.song = FakeSong()
        self.application = FakeApplication()
        self.scheduled = []

    def schedule_message(self, delay, callback):
        self.scheduled.append((delay, callback))


class ExecutorTests(unittest.TestCase):
    def test_executes_registered_commands_only_when_scheduled(self):
        scheduled = []
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda delay, callback: scheduled.append((delay, callback)),
            registry,
            FakeContext(),
        )

        executor.submit(request("session.inspect"), responses.append)

        self.assertEqual(responses, [])
        self.assertEqual(len(scheduled), 1)
        scheduled[0][1]()
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[0]["result"]["trackCount"], 2)
        self.assertEqual(responses[0]["result"]["tracks"][0]["name"], "Drums")
        self.assertEqual(responses[0]["result"]["tracks"][0]["kind"], "midi")

    def test_rejects_unknown_commands(self):
        responses = []
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            CommandRegistry(),
            FakeContext(),
        )

        executor.submit(request("missing.command"), responses.append)

        self.assertEqual(responses[0]["error"]["code"], "unknown_command")

    def test_reports_queue_saturation(self):
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            registry,
            FakeContext(),
            max_queue=1,
        )

        executor.submit(request("system.ping"), responses.append)
        executor.submit(request("system.ping"), responses.append)

        self.assertEqual(responses[0]["error"]["code"], "queue_full")

    def test_close_rejects_queued_work(self):
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            registry,
            FakeContext(),
        )
        executor.submit(request("system.ping"), responses.append)

        executor.close()

        self.assertEqual(responses[0]["error"]["code"], "internal_error")
        self.assertTrue(responses[0]["error"]["retryable"])

    def test_tempo_mutation_is_validated_and_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("transport.set_tempo", {"tempo": 130.5}),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(context.song.tempo, 130.5)
        self.assertEqual(
            responses[0]["result"],
            {
                "beforeTempo": 124.0,
                "afterTempo": 130.5,
                "verified": True,
            },
        )

    def test_tempo_mutation_rejects_out_of_range_values(self):
        scheduled = []
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            FakeContext(),
        )

        executor.submit(
            request("transport.set_tempo", {"tempo": 2}),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "invalid_params")

    def test_transport_play_state_is_changed_and_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("transport.set_playing", {"isPlaying": False}),
            responses.append,
        )
        scheduled.pop()()
        delay, verify = context.scheduled.pop()
        self.assertEqual(delay, 1)
        self.assertEqual(responses, [])
        verify()

        self.assertFalse(context.song.is_playing)
        self.assertEqual(
            responses[0]["result"],
            {
                "beforeIsPlaying": True,
                "afterIsPlaying": False,
                "verified": True,
            },
        )

    def test_track_create_and_delete_are_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("tracks.create", {"kind": "audio", "name": "Vocals"}),
            responses.append,
        )
        scheduled.pop()()
        created_reference = responses[0]["result"]["track"]["reference"]
        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 2,
                    "expectedReference": created_reference,
                    "expectedName": "Vocals",
                    "expectedKind": "audio",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["track"]["name"], "Vocals")
        self.assertEqual(responses[0]["result"]["track"]["kind"], "audio")
        self.assertTrue(responses[0]["result"]["verified"])
        self.assertEqual(responses[1]["result"]["track"]["name"], "Vocals")
        self.assertTrue(responses[1]["result"]["verified"])
        self.assertEqual(len(context.song.tracks), 2)

    def test_track_delete_guards_last_track(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks = [FakeTrack("Only")]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 0,
                    "expectedReference": "00000000-0000-4000-8000-000000000001",
                    "expectedName": "Only",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "conflict")

    def test_track_delete_rejects_stale_identity_and_group_tracks(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0] = FakeTrack("Group", group=True)
        context._track_references = [
            (
                context.song.tracks[0],
                "00000000-0000-4000-8000-000000000001",
            ),
            (
                context.song.tracks[1],
                "00000000-0000-4000-8000-000000000002",
            ),
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 1,
                    "expectedReference": "00000000-0000-4000-8000-000000000099",
                    "expectedName": "Moved Track",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 0,
                    "expectedReference": "00000000-0000-4000-8000-000000000001",
                    "expectedName": "Group",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "stale_reference")
        self.assertEqual(responses[1]["error"]["code"], "conflict")
        self.assertEqual(len(context.song.tracks), 2)

    def test_track_rename_and_mixer_updates_are_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        reference = "00000000-0000-4000-8000-000000000002"
        context._track_references = [(context.song.tracks[1], reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.set_mixer",
                {
                    "index": 1,
                    "expectedReference": reference,
                    "expectedName": "Bass",
                    "isMuted": True,
                    "volume": 0.6,
                    "pan": 0.25,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "tracks.rename",
                {
                    "index": 1,
                    "expectedReference": reference,
                    "expectedName": "Bass",
                    "name": "Sub Bass",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertTrue(responses[0]["result"]["after"]["isMuted"])
        self.assertEqual(responses[0]["result"]["after"]["volume"], 0.6)
        self.assertEqual(responses[0]["result"]["after"]["pan"], 0.25)
        self.assertEqual(responses[1]["result"]["beforeName"], "Bass")
        self.assertEqual(responses[1]["result"]["afterName"], "Sub Bass")
        self.assertEqual(context.song.tracks[1].name, "Sub Bass")

    def test_track_mixer_rejects_unarmable_track_before_other_changes(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0] = FakeTrack("Group", group=True)
        reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [(context.song.tracks[0], reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.set_mixer",
                {
                    "index": 0,
                    "expectedReference": reference,
                    "expectedName": "Group",
                    "isMuted": True,
                    "isArmed": True,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(
            responses[0]["error"]["code"], "unsupported_capability"
        )
        self.assertFalse(context.song.tracks[0].mute)


class CapabilityAndTokenTests(unittest.TestCase):
    def test_capabilities_reflect_registry(self):
        registry = CommandRegistry()
        register_system_commands(registry)
        document = build_capability_document(
            FakeApplication(), FakeSong(), registry
        )

        self.assertEqual(document["liveVersion"], "12.1-test")
        self.assertTrue(document["capabilities"]["session.inspect"])
        self.assertEqual(len(document["projectId"]), 24)

    def test_token_is_created_once(self):
        with tempfile.TemporaryDirectory() as directory:
            first = load_or_create_token(directory)
            second = load_or_create_token(directory)

            self.assertEqual(first, second)
            self.assertEqual(len(first), 64)
            self.assertTrue(
                os.path.exists(os.path.join(directory, ".ableton-agent-token"))
            )


class ImmediateExecutor(object):
    def submit(self, incoming, callback):
        callback(success(incoming, {"pong": True}))


class ServerTests(unittest.TestCase):
    token = "server-test-token-that-is-at-least-thirty-two-chars"

    def setUp(self):
        self.server = RemoteScriptServer(
            ImmediateExecutor(),
            self.token,
            {
                "selectedProtocolVersion": PROTOCOL_VERSION,
                "liveVersion": "12.1-test",
                "remoteScriptVersion": "0.2.0",
                "projectId": "test-project",
                "capabilities": {"system.ping": True},
                "limits": {
                    "maxFrameBytes": 4 * 1024 * 1024,
                    "maxBatchItems": 128,
                },
            },
            port=0,
        )
        self.server.start()
        self.client = socket.create_connection(
            (LOOPBACK_HOST, self.server.port), timeout=1.0
        )
        self.client.settimeout(1.0)
        self.decoder = FrameDecoder()

    def tearDown(self):
        self.client.close()
        self.server.stop()

    def exchange(self, incoming):
        self.client.sendall(encode_frame(incoming))
        while True:
            messages = self.decoder.push(self.client.recv(65536))
            if messages:
                return messages[0]

    def test_requires_authenticated_hello_then_dispatches(self):
        hello = self.exchange(
            request(
                "system.hello",
                {
                    "authenticationToken": self.token,
                    "supportedProtocolVersions": [PROTOCOL_VERSION],
                    "appVersion": "test",
                    "eventSubscriptions": [],
                },
            )
        )
        ping = self.exchange(request("system.ping"))

        self.assertTrue(hello["ok"])
        self.assertEqual(hello["result"]["projectId"], "test-project")
        self.assertEqual(ping["result"], {"pong": True})

    def test_rejects_commands_before_authentication(self):
        response = self.exchange(request("system.ping"))

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "authentication_failed")

    def test_server_runs_on_background_thread(self):
        self.assertNotEqual(self.server._thread.ident, threading.current_thread().ident)

    def test_send_failure_does_not_escape_outbound_flush(self):
        class FailingClient(object):
            def sendall(self, _payload):
                raise OSError("client disconnected")

        self.server._enqueue({"message": "will fail"})

        self.assertFalse(self.server._flush_outbound(FailingClient()))


if __name__ == "__main__":
    unittest.main()
