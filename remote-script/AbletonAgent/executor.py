"""Bounded main-thread executor for all Live Object Model access."""

from __future__ import absolute_import, unicode_literals

import threading

try:
    import queue
except ImportError:  # pragma: no cover - Python 2 compatibility
    import Queue as queue

from .errors import ProtocolFailure
from .messages import failure, success


class DeferredResult(object):
    def __init__(self, start):
        self._start = start

    def start(self, on_success, on_failure):
        self._start(on_success, on_failure)


class MainThreadExecutor(object):
    def __init__(self, schedule_message, registry, context, max_queue=128):
        self._schedule_message = schedule_message
        self._registry = registry
        self._context = context
        self._queue = queue.Queue(maxsize=max_queue)
        self._lock = threading.Lock()
        self._scheduled = False
        self._closed = False

    def submit(self, request, callback):
        command = self._registry.get(request["command"])
        if command is None:
            callback(
                failure(
                    request,
                    "unknown_command",
                    "Unknown command: {0}".format(request["command"]),
                )
            )
            return
        with self._lock:
            if self._closed:
                callback(
                    failure(
                        request,
                        "internal_error",
                        "Remote Script is shutting down",
                        retryable=True,
                    )
                )
                return
            try:
                self._queue.put_nowait((request, command, callback))
            except queue.Full:
                callback(
                    failure(
                        request,
                        "queue_full",
                        "Remote Script request queue is full",
                        retryable=True,
                    )
                )
                return
            if not self._scheduled:
                self._scheduled = True
                self._schedule_message(0, self.drain)

    def drain(self):
        while True:
            try:
                request, command, callback = self._queue.get_nowait()
            except queue.Empty:
                break
            try:
                result = command.execute(self._context, request["params"])
                if isinstance(result, DeferredResult):
                    result.start(
                        lambda value: callback(
                            success(
                                request,
                                value,
                                project_revision=getattr(
                                    self._context, "project_revision", None
                                ),
                            )
                        ),
                        lambda exc: callback(
                            _failure_from_exception(request, exc)
                        ),
                    )
                else:
                    callback(
                        success(
                            request,
                            result,
                            project_revision=getattr(
                                self._context, "project_revision", None
                            ),
                        )
                    )
            except ProtocolFailure as exc:
                callback(
                    failure(
                        request,
                        exc.code,
                        exc.message,
                        retryable=exc.retryable,
                        details=exc.details,
                    )
                )
            except Exception as exc:
                callback(failure(request, "lom_error", str(exc)))
            finally:
                self._queue.task_done()
        with self._lock:
            self._scheduled = False
            if not self._queue.empty() and not self._closed:
                self._scheduled = True
                self._schedule_message(0, self.drain)

    def close(self):
        with self._lock:
            self._closed = True
        while True:
            try:
                request, _command, callback = self._queue.get_nowait()
            except queue.Empty:
                break
            callback(
                failure(
                    request,
                    "internal_error",
                    "Remote Script is shutting down",
                    retryable=True,
                )
            )
            self._queue.task_done()


def _failure_from_exception(request, exc):
    if isinstance(exc, ProtocolFailure):
        return failure(
            request,
            exc.code,
            exc.message,
            retryable=exc.retryable,
            details=exc.details,
        )
    return failure(request, "lom_error", str(exc))
