"""Live Set identity derived from the current LOM Song."""

from __future__ import absolute_import, unicode_literals

import hashlib


def _lom_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def build_project_identity(song):
    file_path = _lom_getattr(song, "file_path", "") or ""
    saved = bool(file_path)
    name = _lom_getattr(song, "name", "untitled")
    identity_source = file_path if saved else name
    identity_source = str(identity_source)
    project_name = str(name or "Untitled")
    return {
        "projectId": hashlib.sha256(
            identity_source.encode("utf-8")
        ).hexdigest()[:24],
        "projectName": project_name,
        "saved": saved,
    }


def all_reachable_parameters(song):
    tracks = list(_lom_getattr(song, "tracks", ()) or ())
    tracks.extend(list(_lom_getattr(song, "return_tracks", ()) or ()))
    master = _lom_getattr(song, "master_track")
    if master is not None:
        tracks.append(master)

    parameters = []
    pending_devices = []
    pending_chains = []
    seen_devices = set()
    seen_chains = set()
    for track in tracks:
        mixer = _lom_getattr(track, "mixer_device")
        if mixer is not None:
            for name in ("volume", "panning", "crossfader", "cue_volume"):
                parameter = _lom_getattr(mixer, name)
                if parameter is not None:
                    parameters.append(parameter)
            parameters.extend(list(_lom_getattr(mixer, "sends", ()) or ()))
        pending_devices.extend(list(_lom_getattr(track, "devices", ()) or ()))

    while pending_devices or pending_chains:
        if pending_devices:
            device = pending_devices.pop()
            if id(device) in seen_devices:
                continue
            seen_devices.add(id(device))
            parameters.extend(list(_lom_getattr(device, "parameters", ()) or ()))
            pending_chains.extend(list(_lom_getattr(device, "chains", ()) or ()))
            drum_pads = list(_lom_getattr(device, "drum_pads", ()) or ())
            for pad in drum_pads:
                pending_chains.extend(list(_lom_getattr(pad, "chains", ()) or ()))
            continue
        chain = pending_chains.pop()
        if id(chain) in seen_chains:
            continue
        seen_chains.add(id(chain))
        mixer = _lom_getattr(chain, "mixer_device")
        if mixer is not None:
            for name in ("volume", "panning"):
                parameter = _lom_getattr(mixer, name)
                if parameter is not None:
                    parameters.append(parameter)
            parameters.extend(list(_lom_getattr(mixer, "sends", ()) or ()))
        pending_devices.extend(list(_lom_getattr(chain, "devices", ()) or ()))

    return parameters
