"""Standalone protocol simulator for bridge integration tests and development."""

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import json
import socket

from AbletonAgent.protocol import FrameDecoder, encode_frame

PROTOCOL_VERSION = 1


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


def handle(request, token):
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
                "capabilities": {"system.ping": True},
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
                "tempo": 120.0,
                "timeSignature": {"numerator": 4, "denominator": 4},
                "isPlaying": False,
                "trackCount": 2,
                "tracks": [
                    {
                        "index": 0,
                        "name": "Drums",
                        "color": 10,
                        "isMuted": False,
                        "isSoloed": False,
                        "isArmed": False,
                    },
                    {
                        "index": 1,
                        "name": "Bass",
                        "color": None,
                        "isMuted": False,
                        "isSoloed": False,
                        "isArmed": True,
                    },
                ],
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
    try:
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            for request in decoder.push(chunk):
                result = handle(request, token)
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
