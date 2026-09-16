"""Bounded main-thread executor for all Live Object Model access."""

from __future__ import absolute_import, unicode_literals

import threading
import time

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
    def __init__(
        self,
        schedule_message,
        registry,
        context,
        max_queue=128,
        max_commands_per_drain=8,
        logger=None,
    ):
        self._schedule_message = schedule_message
        self._registry = registry
        self._context = context
        self._queue = queue.Queue(maxsize=max_queue)
        self._max_commands_per_drain = max(1, max_commands_per_drain)
        self._logger = logger or (lambda _message: None)
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
            self._log(
                "queued",
                request,
                queue_depth=self._queue.qsize(),
            )
            if not self._scheduled:
                self._scheduled = True
                self._schedule_message(0, self.drain)

    def drain(self):
        drain_started = time.monotonic()
        self._log_message(
            "AbletonAgent executor drain started queueDepth={0}".format(
                self._queue.qsize()
            )
        )
        processed = 0
        while processed < self._max_commands_per_drain:
            try:
                request, command, callback = self._queue.get_nowait()
            except queue.Empty:
                break
            processed += 1
            command_started = time.monotonic()
            outcome = "completed"
            self._log("started", request, queue_depth=self._queue.qsize())
            try:
                result = command.execute(self._context, request["params"])
                if isinstance(result, DeferredResult):
                    outcome = "deferred"

                    def deferred_success(
                        value,
                        req=request,
                        cb=callback,
                        started_at=command_started,
                    ):
                        self._log(
                            "completed",
                            req,
                            duration_ms=int(
                                (time.monotonic() - started_at) * 1000
                            ),
                            queue_depth=self._queue.qsize(),
                        )
                        cb(
                            success(
                                req,
                                value,
                                project_revision=getattr(
                                    self._context,
                                    "project_revision",
                                    None,
                                ),
                            )
                        )

                    def deferred_failure(
                        exc,
                        req=request,
                        cb=callback,
                        started_at=command_started,
                    ):
                        self._log(
                            "failed",
                            req,
                            duration_ms=int(
                                (time.monotonic() - started_at) * 1000
                            ),
                            queue_depth=self._queue.qsize(),
                        )
                        cb(_failure_from_exception(req, exc))

                    result.start(
                        deferred_success,
                        deferred_failure,
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
                outcome = "failed"
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
                outcome = "failed"
                callback(failure(request, "lom_error", str(exc)))
            finally:
                if outcome != "deferred":
                    self._log(
                        outcome,
                        request,
                        duration_ms=int(
                            (time.monotonic() - command_started) * 1000
                        ),
                        queue_depth=self._queue.qsize(),
                    )
                self._queue.task_done()
        self._log_message(
            "AbletonAgent executor drain completed processed={0} "
            "remaining={1} durationMs={2}".format(
                processed,
                self._queue.qsize(),
                int((time.monotonic() - drain_started) * 1000),
            )
        )
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
            self._log(
                "cancelled",
                request,
                queue_depth=self._queue.qsize(),
            )
            self._queue.task_done()

    def _log(self, lifecycle, request, duration_ms=None, queue_depth=None):
        fields = [
            "AbletonAgent executor",
            lifecycle,
            "command={0}".format(request.get("command", "")),
            "requestId={0}".format(request.get("requestId", "")),
        ]
        if queue_depth is not None:
            fields.append("queueDepth={0}".format(queue_depth))
        if duration_ms is not None:
            fields.append("durationMs={0}".format(duration_ms))
        self._log_message(" ".join(fields))

    def _log_message(self, message):
        try:
            self._logger(message[:512])
        except Exception:
            pass


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
