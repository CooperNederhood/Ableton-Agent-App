"""Simulator-to-LOM adapter using the production bounded listening command."""

from types import SimpleNamespace

from .listening_commands import inspect_listening_context


def inspect_simulated_listening_context(state, params):
    return inspect_listening_context(build_listening_simulator_context(state), params)


def build_listening_simulator_context(state):
    context = SimpleNamespace(project_revision=0)
    references = {
        "_track_references": [], "_device_references": [],
        "_clip_references": [], "_parameter_references": [],
    }

    def remember(kind, obj, data):
        references[kind].append((obj, data["reference"]))
        return obj

    def clip(data, track, scene_index=None):
        fields = {
            "name": data["name"],
            "is_audio_clip": data.get("kind") == "audio",
            "is_recording": data.get("isRecording", False),
            "is_playing": state.is_playing and (
                track.get("playingSceneIndex") == scene_index
                if scene_index is not None else track.get("playingSceneIndex") is None
                and data.get("startTime", 0) <= state.current_song_time < data.get("endTime", 0)
            ),
        }
        mapping = {
            "start_time": "startTime", "end_time": "endTime",
            "file_path": "filePath", "gain": "gain",
            "pitch_coarse": "pitchCoarse", "pitch_fine": "pitchFine",
            "warping": "warping", "warp_mode": "warpMode",
            "loop_start": "loopStart", "loop_end": "loopEnd",
            "start_marker": "startMarker", "end_marker": "endMarker",
            "looping": "looping", "muted": "muted", "length": "length",
        }
        fields.update({private: data[public] for private, public in mapping.items() if public in data})
        return remember("_clip_references", SimpleNamespace(**fields), data)

    def track(data):
        devices = []
        for item in data["devices"]:
            parameters = [
                remember("_parameter_references", SimpleNamespace(
                    name=value["name"], value=value["value"],
                ), value) for value in item["parameters"]
            ]
            devices.append(remember("_device_references", SimpleNamespace(
                name=item["name"], class_name=item["className"],
                is_active=parameters[0].value >= 0.5 if parameters else None,
                parameters=parameters, can_have_chains=item.get("canHaveChains", False),
            ), item))
        slots = [
            SimpleNamespace(
                has_clip=item is not None,
                clip=clip(item, data, index) if item is not None else None,
            ) for index, item in enumerate(data.get("clips", []))
        ]
        obj = SimpleNamespace(
            name=data["name"], devices=devices, clip_slots=slots,
            arrangement_clips=[clip(item, data) for item in data.get("arrangementClips", [])],
            playing_slot_index=data.get("playingSceneIndex") if data.get("playingSceneIndex") is not None else -1,
            fired_slot_index=-1,
            back_to_arranger=data.get("backToArrangement", False),
            mute=data.get("isMuted", False), solo=data.get("isSoloed", False),
            arm=data.get("isArmed", False),
            current_monitoring_state=data.get("monitoringState"),
            mixer_device=SimpleNamespace(
                volume=SimpleNamespace(value=data.get("volume")),
                panning=SimpleNamespace(value=data.get("pan")),
                crossfader_assign=data.get("crossfaderAssign"),
            ),
        )
        return remember("_track_references", obj, data)

    context.song = SimpleNamespace(
        tracks=[track(item) for item in state.tracks],
        return_tracks=[track(item) for item in state.return_tracks],
        master_track=track(state.master_track),
        is_playing=state.is_playing, current_song_time=state.current_song_time,
        tempo=state.tempo,
        record_mode=state.recording_state["arrangementRecord"],
        session_record=state.recording_state["sessionRecord"],
        overdub=state.recording_state["overdub"],
        arrangement_overdub=state.recording_state["overdub"],
        session_automation_record=state.recording_state["sessionAutomationRecord"],
        loop=state.loop_enabled, back_to_arranger=state.back_to_arrangement,
    )
    def continue_playing():
        state.current_song_time = context.song.current_song_time
        state.is_playing = True
        context.song.is_playing = True
    context.song.continue_playing = continue_playing
    for key, entries in references.items():
        setattr(context, key, entries)
    return context
