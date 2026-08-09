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
    def __init__(self, name):
        self.name = name
        self.color = 10
        self.mute = False
        self.solo = False
        self.arm = True


class FakeSong(object):
    tempo = 124.0
    signature_numerator = 4
    signature_denominator = 4
    is_playing = True
    file_path = "/tmp/example.als"
    tracks = [FakeTrack("Drums"), FakeTrack("Bass")]


class FakeApplication(object):
    def get_version_string(self):
        return "12.1-test"


class FakeContext(object):
    song = FakeSong()
    application = FakeApplication()


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
