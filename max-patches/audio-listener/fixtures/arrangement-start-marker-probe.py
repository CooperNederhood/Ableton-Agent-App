"""One-run instrumented capability probe in a runner-owned Untitled Set."""
import json
import time
import uuid

OUTPUT = "/Users/cooper/.copilot/repos/copilot-worktrees/ableton-agent-app/coopernederhood-issue-29-implementation-investigate-structured-a-456c8f/.test-artifacts/start-marker-probe-result.json"


def begin(context):
    song = context.song
    started = time.monotonic()
    trace = str(uuid.uuid4())
    evidence = {
        "formatVersion": 1,
        "classification": "instrumented-capability-probe",
        "productionAcceptance": False,
        "sourceOnset": "unverified",
        "requestedStartBeat": 5.25,
        "events": [],
    }
    before = None

    def record(stage, values):
        evidence["events"].append({
            "eventId": str(uuid.uuid4()), "traceId": trace,
            "stage": stage, "elapsedMs": (time.monotonic() - started) * 1000,
            "values": values,
        })
        with open(OUTPUT, "w") as output:
            json.dump(evidence, output, indent=2)

    def state():
        return {
            "marker": song.start_time,
            "position": song.current_song_time,
            "playing": song.is_playing,
        }

    def guards():
        if song.file_path != "" or song.name not in ("", "Untitled"):
            raise RuntimeError("probe_requires_owned_untitled")
        for field in ("is_playing", "loop", "back_to_arranger", "record_mode",
                      "session_record", "session_automation_record", "overdub"):
            if getattr(song, field) is not False:
                raise RuntimeError("unsafe_probe_" + field)

    def restore():
        song.stop_playing()
        song.start_time = before["marker"]
        song.current_song_time = before["position"]
        context.schedule_message(2, restored)

    def restored():
        try:
            guards()
            after = state()
            if after != before:
                raise RuntimeError("probe_restore_mismatch")
            record("completed", {"restored": after})
        except Exception as error:
            record("failed", {"reason": type(error).__name__, "stage": "restore"})

    def verify_play():
        try:
            after = state()
            if (after["playing"] is not True or after["marker"] != 5.25
                    or not (5.25 <= after["position"] < 7.25)):
                raise RuntimeError("probe_start_readback_mismatch")
            record("progress", {"stage": "independent_play_readback", **after})
        except Exception as error:
            record("failed", {"reason": type(error).__name__, "stage": "start"})
        finally:
            restore()

    def play():
        try:
            guards()
            after = state()
            if after["marker"] != 5.25 or after["position"] != 5.25:
                raise RuntimeError("probe_seek_readback_mismatch")
            record("progress", {"stage": "independent_position_readback", **after})
            song.start_playing()
            context.schedule_message(2, verify_play)
        except Exception as error:
            record("failed", {"reason": type(error).__name__, "stage": "play"})
            restore()

    def verify_marker():
        try:
            guards()
            after = state()
            if after["marker"] != 5.25:
                raise RuntimeError("probe_marker_readback_mismatch")
            record("progress", {"stage": "independent_marker_readback", **after})
            song.current_song_time = 5.25
            context.schedule_message(2, play)
        except Exception as error:
            record("failed", {"reason": type(error).__name__, "stage": "marker"})
            restore()

    try:
        record("queued", {})
        properties = {}
        for field in ("name", "file_path", "start_time", "current_song_time",
                      "is_playing", "loop", "back_to_arranger", "record_mode",
                      "session_record", "session_automation_record", "overdub"):
            try:
                value = getattr(song, field)
                properties[field] = (
                    {"untitled": value == "Untitled", "empty": value == ""} if field == "name"
                    else {"saved": bool(value)} if field == "file_path"
                    else {"value": value}
                )
            except Exception as error:
                properties[field] = {"unavailable": type(error).__name__}
        record("progress", {"stage": "property_inventory", "properties": properties})
        guards()
        before = state()
        record("started", {"before": before})
        song.start_time = 5.25
        context.schedule_message(2, verify_marker)
    except Exception as error:
        record("failed", {"reason": type(error).__name__, "stage": "initial"})
