"""Standalone protocol simulator for bridge integration tests and development."""

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import json
import socket
import uuid

from AbletonAgent.protocol import FrameDecoder, encode_frame

PROTOCOL_VERSION = 2


class SimulatorState(object):
    def __init__(self):
        self.tempo = 120.0
        self.is_playing = False
        self.tracks = [
            {
                "reference": str(
                    uuid.uuid5(uuid.NAMESPACE_URL, "ableton-agent-simulator-drums")
                ),
                "name": "Drums",
                "kind": "midi",
                "color": 10,
                "isMuted": False,
                "isSoloed": False,
                "isArmed": False,
            },
            {
                "reference": str(
                    uuid.uuid5(uuid.NAMESPACE_URL, "ableton-agent-simulator-bass")
                ),
                "name": "Bass",
                "kind": "midi",
                "color": None,
                "isMuted": False,
                "isSoloed": False,
                "isArmed": True,
            },
        ]

    def session_tracks(self):
        return [
            dict({"index": index}, **track)
            for index, track in enumerate(self.tracks)
        ]


def response(request, result):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request["requestId"],
        "ok": True,
        "result": result,
        "warnings": [],
    }


def failure(request, code, message):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request["requestId"],
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": False,
            "details": {},
        },
    }


def handle(request, token, state):
    if request.get("kind") != "request":
        return None
    command = request.get("command")
    params = request.get("params", {})
    if command == "system.hello":
        if params.get("authenticationToken") != token:
            return failure(
                request, "authentication_failed", "Invalid authentication token"
            )
        if PROTOCOL_VERSION not in params.get(
            "supportedProtocolVersions", []
        ):
            return failure(
                request,
                "protocol_version_unsupported",
                "No supported protocol version",
            )
        return response(
            request,
            {
                "selectedProtocolVersion": PROTOCOL_VERSION,
                "liveVersion": "12.1-simulator",
                "remoteScriptVersion": "0.2.0",
                "projectId": "simulated-project",
                "capabilities": {
                    "system.ping": True,
                    "session.inspect": True,
                    "transport.set_tempo": True,
                    "transport.set_playing": True,
                    "tracks.create": True,
                    "tracks.delete": True,
                },
                "limits": {
                    "maxFrameBytes": 4 * 1024 * 1024,
                    "maxBatchItems": 128,
                },
            },
        )
    if command == "system.ping":
        return response(request, {"pong": True})
    if command == "session.inspect":
        return response(
            request,
            {
                "tempo": state.tempo,
                "timeSignature": {"numerator": 4, "denominator": 4},
                "isPlaying": state.is_playing,
                "trackCount": len(state.tracks),
                "tracks": state.session_tracks(),
            },
        )
    if command == "transport.set_tempo":
        tempo = params.get("tempo")
        if (
            isinstance(tempo, bool)
            or not isinstance(tempo, (int, float))
            or tempo < 20
            or tempo > 999
        ):
            return failure(
                request,
                "invalid_params",
                "tempo must be between 20 and 999 BPM",
            )
        before = state.tempo
        state.tempo = tempo
        return response(
            request,
            {
                "beforeTempo": before,
                "afterTempo": tempo,
                "verified": True,
            },
        )
    if command == "transport.set_playing":
        is_playing = params.get("isPlaying")
        if not isinstance(is_playing, bool):
            return failure(
                request,
                "invalid_params",
                "isPlaying must be a boolean",
            )
        before = state.is_playing
        state.is_playing = is_playing
        return response(
            request,
            {
                "beforeIsPlaying": before,
                "afterIsPlaying": is_playing,
                "verified": True,
            },
        )
    if command == "tracks.create":
        kind = params.get("kind")
        name = params.get("name")
        if kind not in ("midi", "audio"):
            return failure(request, "invalid_params", "kind must be midi or audio")
        before_count = len(state.tracks)
        track = {
            "reference": str(uuid.uuid4()),
            "name": name or ("MIDI" if kind == "midi" else "Audio"),
            "kind": kind,
            "color": None,
            "isMuted": False,
            "isSoloed": False,
            "isArmed": False,
        }
        state.tracks.append(track)
        return response(
            request,
            {
                "beforeTrackCount": before_count,
                "afterTrackCount": len(state.tracks),
                "track": {
                    "index": before_count,
                    "reference": track["reference"],
                    "name": track["name"],
                    "kind": kind,
                },
                "verified": True,
            },
        )
    if command == "tracks.delete":
        index = params.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return failure(request, "invalid_params", "index must be non-negative")
        if len(state.tracks) <= 1:
            return failure(request, "conflict", "Cannot delete the last track")
        if index >= len(state.tracks):
            return failure(request, "not_found", "Track index is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
            or track["kind"] != params.get("expectedKind")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before deletion",
            )
        before_count = len(state.tracks)
        del state.tracks[index]
        return response(
            request,
            {
                "beforeTrackCount": before_count,
                "afterTrackCount": len(state.tracks),
                "track": {
                    "index": index,
                    "reference": track["reference"],
                    "name": track["name"],
                    "kind": track["kind"],
                },
                "verified": True,
            },
        )
    return failure(request, "unknown_command", "Unknown command: {0}".format(command))


def serve(host, port, token):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)
    print(
        json.dumps({"host": host, "port": server.getsockname()[1]}),
        flush=True,
    )
    connection, _address = server.accept()
    decoder = FrameDecoder()
    state = SimulatorState()
    try:
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            for request in decoder.push(chunk):
                result = handle(request, token, state)
                if result is not None:
                    connection.sendall(encode_frame(result))
    finally:
        connection.close()
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    serve(args.host, args.port, args.token)


if __name__ == "__main__":
    main()
