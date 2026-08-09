"""Authenticated loopback socket server owned by the Remote Script."""

from __future__ import absolute_import, unicode_literals

import socket
import threading

try:
    import queue
except ImportError:  # pragma: no cover - Python 2 compatibility
    import Queue as queue

from .messages import PROTOCOL_VERSION, failure, success, validate_request
from .protocol import FrameDecodeError, FrameDecoder, encode_frame

LOOPBACK_HOST = "127.0.0.1"


class RemoteScriptServer(object):
    def __init__(
        self,
        executor,
        authentication_token,
        capability_document,
        port=8765,
        max_outbound=128,
        logger=None,
    ):
        self._executor = executor
        self._authentication_token = authentication_token
        self._capability_document = capability_document
        self._port = port
        self._logger = logger or (lambda _message: None)
        self._outbound = queue.Queue(maxsize=max_outbound)
        self._stop_event = threading.Event()
        self._thread = None
        self._server_socket = None
        self._client_socket = None

    @property
    def port(self):
        if self._server_socket is None:
            return self._port
        return self._server_socket.getsockname()[1]

    def start(self):
        if self._thread is not None:
            return
        self._server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_socket.bind((LOOPBACK_HOST, self._port))
        self._server_socket.listen(1)
        self._server_socket.settimeout(0.2)
        self._thread = threading.Thread(target=self._run, name="AbletonAgentServer")
        self._thread.daemon = True
        self._thread.start()
        self._logger("Ableton Agent listening on {0}:{1}".format(LOOPBACK_HOST, self.port))

    def stop(self):
        self._stop_event.set()
        for active_socket in (self._client_socket, self._server_socket):
            if active_socket is not None:
                try:
                    active_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    active_socket.close()
                except OSError:
                    pass
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._thread = None
        self._client_socket = None
        self._server_socket = None

    def _run(self):
        while not self._stop_event.is_set():
            try:
                client, _address = self._server_socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self._client_socket = client
            try:
                self._serve_client(client)
            finally:
                try:
                    client.close()
                except OSError:
                    pass
                self._client_socket = None

    def _serve_client(self, client):
        client.settimeout(0.05)
        decoder = FrameDecoder()
        authenticated = False
        while not self._stop_event.is_set():
            if not self._flush_outbound(client):
                break
            try:
                chunk = client.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            try:
                messages = decoder.push(chunk)
            except FrameDecodeError:
                break
            for request in messages:
                error = validate_request(request)
                if error:
                    self._enqueue(failure(request if isinstance(request, dict) else {}, "invalid_request", error))
                    continue
                if not authenticated:
                    authenticated = self._handle_hello(request)
                    continue
                if request["command"] == "system.hello":
                    self._enqueue(failure(request, "invalid_request", "Handshake already completed"))
                    continue
                self._executor.submit(request, self._enqueue)
        self._flush_outbound(client)

    def _handle_hello(self, request):
        if request["command"] != "system.hello":
            self._enqueue(failure(request, "authentication_failed", "system.hello is required"))
            return False
        params = request["params"]
        if params.get("authenticationToken") != self._authentication_token:
            self._enqueue(failure(request, "authentication_failed", "Invalid authentication token"))
            return False
        if PROTOCOL_VERSION not in params.get("supportedProtocolVersions", []):
            self._enqueue(
                failure(
                    request,
                    "protocol_version_unsupported",
                    "No supported protocol version",
                )
            )
            return False
        self._enqueue(success(request, self._capability_document))
        return True

    def _enqueue(self, message):
        try:
            self._outbound.put_nowait(message)
        except queue.Full:
            self._logger("Dropping response because outbound queue is full")

    def _flush_outbound(self, client):
        while True:
            try:
                message = self._outbound.get_nowait()
            except queue.Empty:
                return True
            try:
                client.sendall(encode_frame(message))
            except OSError:
                return False
            finally:
                self._outbound.task_done()
