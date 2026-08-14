"""Bounded Ableton Browser inspection, search, and built-in device loading."""

from __future__ import absolute_import, unicode_literals

import time
import uuid
from collections import deque
import re

from .device_commands import _device_summary
from .errors import ProtocolFailure
from .system_commands import (
    _resolve_track,
    _same_lom_object,
    _track_kind,
    _track_reference,
    _validate_track_target,
)

BROWSER_CHILD_LIMIT = 64
BROWSER_SEARCH_NODE_LIMIT = 256
BROWSER_SEARCH_RESULT_LIMIT = 32
BROWSER_SEARCH_DEPTH_LIMIT = 6
BROWSER_SEARCH_DURATION_LIMIT_MS = 250
BROWSER_REFERENCE_CACHE_LIMIT = 512
BROWSER_STATE_ITEM_LIMIT = 128
BROWSER_ADDED_DEVICE_LIMIT = 16

BROWSER_ROOTS = (
    ("sounds", "Sounds", False),
    ("drums", "Drums", False),
    ("instruments", "Instruments", True),
    ("audio_effects", "Audio Effects", True),
    ("midi_effects", "MIDI Effects", True),
    ("max_for_live", "Max for Live", False),
    ("plugins", "Plug-ins", False),
    ("clips", "Clips", False),
    ("samples", "Samples", False),
    ("packs", "Packs", False),
    ("user_library", "User Library", False),
    ("current_project", "Current Project", False),
)
DEFAULT_SEARCH_ROOTS = frozenset(
    root
    for root, _label, is_default_search_root in BROWSER_ROOTS
    if is_default_search_root
)
ROOT_KEYS = tuple(root for root, _label, _is_default_search_root in BROWSER_ROOTS)


def _browser(context):
    browser = getattr(context.application, "browser", None)
    if browser is None:
        raise ProtocolFailure(
            "unsupported_capability", "Ableton Browser API is unavailable"
        )
    return browser


def _root_item(browser, root):
    if root not in ROOT_KEYS:
        raise ProtocolFailure("invalid_params", "Unknown browser root")
    item = getattr(browser, root, None)
    if item is None:
        raise ProtocolFailure(
            "unsupported_capability",
            "Browser root is unavailable",
            details={"root": root},
        )
    return item


def _item_name(item):
    return str(getattr(item, "name", "") or "")


def _item_uri(item):
    return str(getattr(item, "uri", "") or "")


def _item_source(item):
    return str(getattr(item, "source", "") or "")


_EXTERNAL_PLUGIN_SOURCE_MARKERS = ("plugin", "vst", "audio_unit")
_EXTERNAL_PLUGIN_URI_MARKERS = ("plugin", "vst", "audio_unit", "external")
_DEVICE_PRESET_SUFFIXES = (".adv", ".adg", ".amxd")


def _item_is_trusted_internal_content(root, item):
    """Dedicated policy boundary excluding external plugins.

    Exact Browser-resolved device presets may use Ableton or file URIs,
    especially in User Library. Third-party VST/Audio Unit plugins remain
    excluded and retain their dedicated search/approval boundary.
    """
    source = _item_source(item).strip().casefold().replace(" ", "_")
    uri = _item_uri(item).strip().casefold()
    if root == "plugins":
        return False
    if any(marker in source for marker in _EXTERNAL_PLUGIN_SOURCE_MARKERS):
        return False
    if any(marker in uri for marker in _EXTERNAL_PLUGIN_URI_MARKERS):
        return False
    return True


def _iter_children(item):
    """Yield an item's children, bounded to what can be safely read.

    Live 11 exposes some virtual-container items (for example Drums)
    whose ``iter_children``/``children`` descriptors can raise instead of
    returning an empty result. Any failure while obtaining the iterator or
    while advancing it is treated as "no further children" rather than
    propagating, since callers only ever need a bounded, best-effort view.
    """
    try:
        iterator = getattr(item, "iter_children", None)
        if callable(iterator):
            raw = iter(iterator())
        else:
            raw = iter(getattr(item, "children", ()))
    except Exception:
        return
    while True:
        try:
            child = next(raw)
        except StopIteration:
            return
        except Exception:
            return
        yield child


def _item_has_children(item):
    """Bounded, safe probe for at least one child (does not enumerate)."""
    for _child in _iter_children(item):
        return True
    return False


def _item_is_navigable(item):
    """True if an item can be traversed for children.

    Live 11 Browser virtual containers (for example Drums) may report
    ``is_folder=False`` while still exposing children, so navigability is
    determined by ``is_folder`` OR a safe, bounded children probe rather
    than ``is_folder`` alone.
    """
    if bool(getattr(item, "is_folder", False)):
        return True
    return _item_has_children(item)


def _item_is_loadable_device(root, item):
    """Safe semantic classification for target-aware device loading.

    A device or device preset may be loaded regardless of which Browser
    root exposes it (Drums, Packs, User Library, ...), as long as it is
    reported as a device, is directly loadable, is not itself a
    navigable container, and is trusted internal content (not an
    external plugin).
    """
    name = _item_name(item).strip().casefold()
    is_device_or_preset = bool(
        getattr(item, "is_device", False)
    ) or name.endswith(_DEVICE_PRESET_SUFFIXES)
    return (
        is_device_or_preset
        and bool(getattr(item, "is_loadable", False))
        and not _item_is_navigable(item)
        and _item_is_trusted_internal_content(root, item)
    )


def _item_identity(root, path, item):
    return (
        root,
        tuple((segment["index"], segment["name"]) for segment in path),
        _item_name(item),
        _item_uri(item),
        bool(getattr(item, "is_folder", False)),
        bool(getattr(item, "is_loadable", False)),
        bool(getattr(item, "is_device", False)),
        _item_source(item),
    )


def _browser_reference(context, root, path, item):
    identity = _item_identity(root, path, item)
    cache = list(getattr(context, "_browser_reference_cache", []))
    matching = None
    retained = []
    path_key = identity[:2]
    for entry in cache:
        if entry["identity"] == identity:
            matching = entry
        elif entry["identity"][:2] != path_key:
            retained.append(entry)
    if matching is None:
        matching = {"identity": identity, "reference": str(uuid.uuid4())}
    retained.append(matching)
    context._browser_reference_cache = retained[-BROWSER_REFERENCE_CACHE_LIMIT:]
    return matching["reference"]


def _item_summary(context, root, path, item):
    return {
        "reference": _browser_reference(context, root, path, item),
        "root": root,
        "path": list(path),
        "name": _item_name(item),
        "uri": _item_uri(item),
        "isFolder": bool(getattr(item, "is_folder", False)),
        "isNavigable": _item_is_navigable(item),
        "isLoadable": bool(getattr(item, "is_loadable", False)),
        "isDevice": bool(getattr(item, "is_device", False)),
        "source": _item_source(item),
        "isLoadableDevice": _item_is_loadable_device(root, item),
        # Retained for protocol compatibility with older application builds.
        "isBuiltInDevice": _item_is_loadable_device(root, item),
    }


def _resolve_path(browser, root, path):
    item = _root_item(browser, root)
    for segment in path:
        if not _item_is_navigable(item):
            raise ProtocolFailure(
                "stale_reference",
                "Browser path no longer points through a folder",
                details={"root": root, "path": path},
            )
        index = segment["index"]
        child = None
        for child_index, candidate in enumerate(_iter_children(item)):
            if child_index == index:
                child = candidate
                break
        if child is None:
            raise ProtocolFailure(
                "stale_reference",
                "Browser path index is no longer available",
                details={"root": root, "path": path},
            )
        item = child
        if _item_name(item) != segment["name"]:
            raise ProtocolFailure(
                "stale_reference",
                "Browser path name changed",
                details={
                    "root": root,
                    "path": path,
                    "actualName": _item_name(item),
                },
            )
    return item


def _resolve_expected_item(context, params):
    browser = _browser(context)
    root = params["expectedItemRoot"]
    path = params["expectedItemPath"]
    item = _resolve_path(browser, root, path)
    actual = _item_summary(context, root, path, item)
    expected = {
        "reference": params["expectedItemReference"],
        "name": params["expectedItemName"],
        "uri": params["expectedItemUri"],
    }
    if any(actual[key] != value for key, value in expected.items()):
        raise ProtocolFailure(
            "stale_reference",
            "Browser item identity changed",
            details={
                "expectedReference": expected["reference"],
                "actualReference": actual["reference"],
                "expectedName": expected["name"],
                "actualName": actual["name"],
                "expectedUri": expected["uri"],
                "actualUri": actual["uri"],
            },
        )
    return browser, item, actual


def _validate_path(path):
    if not isinstance(path, list) or len(path) > 16:
        return "expectedPath must contain at most 16 segments"
    for segment in path:
        if not isinstance(segment, dict) or set(segment.keys()) != set(
            ["index", "name"]
        ):
            return "Each browser path segment requires index and name"
        index = segment.get("index")
        name = segment.get("name")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index > 4096
            or not isinstance(name, str)
            or not name
            or len(name) > 256
        ):
            return "Browser path segments must have bounded index and name"
    return None


def _validate_item_target(params, accepted):
    required = set(
        [
            "expectedItemReference",
            "expectedItemRoot",
            "expectedItemPath",
            "expectedItemName",
            "expectedItemUri",
        ]
    )
    if set(params.keys()) - set(accepted) or not required.issubset(params):
        return "Exact browser item identity is required"
    try:
        uuid.UUID(params.get("expectedItemReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedItemReference must be a UUID"
    if params.get("expectedItemRoot") not in ROOT_KEYS:
        return "expectedItemRoot is not a supported browser root"
    message = _validate_path(params.get("expectedItemPath"))
    if message:
        return message
    name = params.get("expectedItemName")
    uri = params.get("expectedItemUri")
    if not isinstance(name, str) or not name or len(name) > 256:
        return "expectedItemName must be a bounded non-empty string"
    if not isinstance(uri, str) or len(uri) > 2048:
        return "expectedItemUri must be a bounded string"
    return None


def _no_params(params):
    return "Command does not accept parameters" if params else None


def inspect_roots(context, _params):
    browser = _browser(context)
    roots = []
    for root, _label, _loadable in BROWSER_ROOTS:
        item = getattr(browser, root, None)
        if item is not None:
            roots.append(_item_summary(context, root, [], item))
    return {"roots": roots, "cacheLimit": BROWSER_REFERENCE_CACHE_LIMIT}


def _inspect_children_params(params):
    accepted = set(
        [
            "expectedItemReference",
            "expectedItemRoot",
            "expectedItemPath",
            "expectedItemName",
            "expectedItemUri",
            "offset",
            "limit",
        ]
    )
    message = _validate_item_target(params, accepted)
    if message:
        return message
    offset = params.get("offset", 0)
    limit = params.get("limit", 32)
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or offset > 4096
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > BROWSER_CHILD_LIMIT
        or offset + limit - 1 > 4096
    ):
        return "offset and limit must describe a bounded browser page"
    return None


def inspect_children(context, params):
    _browser_object, item, parent = _resolve_expected_item(context, params)
    if not parent["isNavigable"]:
        raise ProtocolFailure(
            "conflict",
            "The targeted browser item is not a navigable container",
        )
    offset = params.get("offset", 0)
    limit = params.get("limit", 32)
    page = []
    scanned = 0
    has_more = False
    for index, child in enumerate(_iter_children(item)):
        scanned = index + 1
        if index < offset:
            continue
        if len(page) >= limit:
            has_more = True
            break
        path = list(params["expectedItemPath"]) + [
            {"index": index, "name": _item_name(child)}
        ]
        page.append(
            _item_summary(context, params["expectedItemRoot"], path, child)
        )
    return {
        "parent": parent,
        "items": page,
        "total": None if has_more else scanned,
        "hasMore": has_more,
        "offset": offset,
        "limit": limit,
    }


def _search_params(params):
    accepted = set(
        [
            "query",
            "roots",
            "maxNodes",
            "maxResults",
            "maxDepth",
            "maxDurationMs",
        ]
    )
    if set(params.keys()) - accepted or "query" not in params:
        return "query is required"
    query = params.get("query")
    if (
        not isinstance(query, str)
        or not query.strip()
        or len(query) > 128
    ):
        return "query must be a non-empty string of at most 128 characters"
    roots = params.get("roots", list(DEFAULT_SEARCH_ROOTS))
    if (
        not isinstance(roots, list)
        or not roots
        or len(roots) > len(ROOT_KEYS)
        or len(set(roots)) != len(roots)
        or any(root not in ROOT_KEYS for root in roots)
    ):
        return "roots must be a non-empty unique list of browser roots"
    limits = (
        ("maxNodes", 128, 1, BROWSER_SEARCH_NODE_LIMIT),
        ("maxResults", 20, 1, BROWSER_SEARCH_RESULT_LIMIT),
        ("maxDepth", 4, 0, BROWSER_SEARCH_DEPTH_LIMIT),
        ("maxDurationMs", 100, 10, BROWSER_SEARCH_DURATION_LIMIT_MS),
    )
    for key, default, minimum, maximum in limits:
        value = params.get(key, default)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < minimum
            or value > maximum
        ):
            return "{0} must be an integer from {1} to {2}".format(
                key, minimum, maximum
            )
    return None


def _search_tokens(query):
    return frozenset(
        token
        for token in re.findall(r"[a-z0-9]+", query.casefold())
        if len(token) > 1
    )


def _search_branch_score(item, query_tokens):
    if not query_tokens:
        return 0
    item_tokens = _search_tokens(_item_name(item))
    return len(query_tokens.intersection(item_tokens))


def _search_result_rank(query, summary):
    name = summary["name"].casefold()
    stem = name
    for suffix in _DEVICE_PRESET_SUFFIXES:
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return (
        0 if stem == query else 1,
        0 if summary.get("isLoadableDevice") else 1,
        0 if summary["isLoadable"] else 1,
        0 if not summary.get("isNavigable") else 1,
        len(summary["path"]),
        name,
        summary["uri"],
    )


def search(context, params):
    browser = _browser(context)
    query = params["query"].strip().casefold()
    query_tokens = _search_tokens(query)
    requested_roots = set(params.get("roots", list(DEFAULT_SEARCH_ROOTS)))
    max_nodes = params.get("maxNodes", 128)
    max_results = params.get("maxResults", 20)
    max_depth = params.get("maxDepth", 4)
    max_duration_ms = params.get("maxDurationMs", 100)
    deadline = time.monotonic() + (max_duration_ms / 1000.0)
    queue = deque()
    node_limit_truncated = False
    for root, _label, _loadable in BROWSER_ROOTS:
        if root not in requested_roots:
            continue
        root_item = getattr(browser, root, None)
        if root_item is not None:
            if len(queue) >= max_nodes:
                node_limit_truncated = True
                continue
            queue.append((root, root_item, [], 0))
    results = []
    visited_nodes = 0
    stop_reason = "complete"
    depth_limit_truncated = False
    while queue:
        if visited_nodes >= max_nodes:
            stop_reason = "node_limit"
            break
        if time.monotonic() >= deadline:
            stop_reason = "time_limit"
            break
        root, item, path, depth = queue.popleft()
        visited_nodes += 1
        if path and query in _item_name(item).casefold():
            results.append(_item_summary(context, root, path, item))
            if len(results) >= max_results:
                stop_reason = "result_limit"
                break
        if not _item_is_navigable(item):
            continue
        if depth >= max_depth:
            if _item_has_children(item):
                depth_limit_truncated = True
            continue
        children_by_score = {}
        for index, child in enumerate(_iter_children(item)):
            if time.monotonic() >= deadline:
                stop_reason = "time_limit"
                break
            child_path = list(path) + [
                {"index": index, "name": _item_name(child)}
            ]
            score = _search_branch_score(child, query_tokens)
            candidates = children_by_score.setdefault(score, [])
            if len(candidates) < max_nodes:
                candidates.append((root, child, child_path, depth + 1))
            else:
                node_limit_truncated = True
        available = max(0, max_nodes - visited_nodes - len(queue))
        selected = []
        for score in sorted(children_by_score, reverse=True):
            candidates = children_by_score[score]
            take = min(available - len(selected), len(candidates))
            if take > 0:
                selected.extend(candidates[:take])
            if take < len(candidates):
                node_limit_truncated = True
            if len(selected) >= available:
                break
        preferred_count = sum(
            1
            for entry in selected
            if _search_branch_score(entry[1], query_tokens) > 0
        )
        preferred_children = selected[:preferred_count]
        other_children = selected[preferred_count:]
        for entry in reversed(preferred_children):
            queue.appendleft(entry)
        queue.extend(other_children)
        if stop_reason == "time_limit":
            break
    if stop_reason == "complete" and node_limit_truncated:
        stop_reason = "node_limit"
    elif stop_reason == "complete" and depth_limit_truncated:
        stop_reason = "depth_limit"
    return {
        "query": params["query"].strip(),
        "items": sorted(
            results, key=lambda summary: _search_result_rank(query, summary)
        ),
        "visitedNodes": visited_nodes,
        "truncated": (
            stop_reason != "complete"
            or bool(queue)
            or node_limit_truncated
            or depth_limit_truncated
        ),
        "stopReason": stop_reason,
        "limits": {
            "maxNodes": max_nodes,
            "maxResults": max_results,
            "maxDepth": max_depth,
            "maxDurationMs": max_duration_ms,
        },
    }


def _load_item_params(params):
    item_keys = set(
        [
            "expectedItemReference",
            "expectedItemRoot",
            "expectedItemPath",
            "expectedItemName",
            "expectedItemUri",
        ]
    )
    message = _validate_track_target(params, item_keys)
    if message:
        return message
    return _validate_item_target(params, set(params.keys()))


def _track_load_state(context, track, track_index):
    devices = list(getattr(track, "devices", ()))
    occupied = [
        index
        for index, slot in enumerate(getattr(track, "clip_slots", ()))
        if bool(getattr(slot, "has_clip", False))
    ]
    return {
        "deviceCount": len(devices),
        "deviceReferences": [
            _device_summary(
                context,
                _track_reference(context, track),
                track_index,
                index,
                device,
            )["reference"]
            for index, device in enumerate(devices[:BROWSER_STATE_ITEM_LIMIT])
        ],
        "deviceNames": [
            str(getattr(device, "name", "") or "")
            for device in devices[:BROWSER_STATE_ITEM_LIMIT]
        ],
        "devicesTruncated": len(devices) > BROWSER_STATE_ITEM_LIMIT,
        "sessionClipCount": len(occupied),
        "occupiedSessionSlots": occupied[:BROWSER_STATE_ITEM_LIMIT],
        "clipsTruncated": len(occupied) > BROWSER_STATE_ITEM_LIMIT,
    }


def _state_details(before, after, outcome):
    return {"outcome": outcome, "before": before, "after": after}


def load_item(context, params):
    track = _resolve_track(context, params)
    track_index = params["index"]
    browser, item, item_summary = _resolve_expected_item(context, params)
    root = params["expectedItemRoot"]
    if not item_summary["isLoadableDevice"]:
        raise ProtocolFailure(
            "conflict",
            "Only trusted built-in device or device-preset items may be"
            " loaded",
            details={
                "root": root,
                "isDevice": item_summary["isDevice"],
                "isLoadable": item_summary["isLoadable"],
                "isNavigable": item_summary["isNavigable"],
                "source": item_summary["source"],
                "uri": item_summary["uri"],
            },
        )
    if root in ("drums", "instruments", "midi_effects") and _track_kind(
        track
    ) != "midi":
        raise ProtocolFailure(
            "conflict",
            "The selected browser item requires a MIDI track",
            details={"root": root, "trackKind": _track_kind(track)},
        )
    if getattr(browser, "hotswap_target", None) is not None:
        raise ProtocolFailure(
            "conflict",
            "Browser hotswap is active; refusing an ambiguous replacement",
        )
    song_view = getattr(context.song, "view", None)
    if song_view is None or not hasattr(song_view, "selected_track"):
        raise ProtocolFailure(
            "unsupported_capability",
            "Selected-track targeting is unavailable",
        )
    before_devices = list(getattr(track, "devices", ()))
    before = _track_load_state(context, track, track_index)
    previous_selected_track = song_view.selected_track
    load_error = None
    restore_error = None
    try:
        song_view.selected_track = track
        if not _same_lom_object(song_view.selected_track, track):
            raise ProtocolFailure(
                "conflict", "Ableton did not select the requested target track"
            )
        browser.load_item(item)
    except ProtocolFailure:
        raise
    except Exception as exc:
        load_error = exc
    finally:
        try:
            song_view.selected_track = previous_selected_track
        except Exception as exc:
            restore_error = exc
    after_devices = list(getattr(track, "devices", ()))
    after = _track_load_state(context, track, track_index)
    added = [
        device
        for device in after_devices
        if not any(
            _same_lom_object(device, previous) for previous in before_devices
        )
    ]
    reconfigured_indices = [
        index
        for index in range(min(len(before_devices), len(after_devices)))
        if _same_lom_object(before_devices[index], after_devices[index])
        and before["deviceNames"][index] != after["deviceNames"][index]
    ]
    changed = bool(added) or bool(reconfigured_indices)
    if load_error is not None or restore_error is not None or not changed:
        outcome = "indeterminate" if changed else "not_observed"
        details = _state_details(before, after, outcome)
        if load_error is not None:
            details["loadError"] = str(load_error)
        if restore_error is not None:
            details["selectionRestoreError"] = str(restore_error)
        raise ProtocolFailure(
            "lom_error",
            "Browser load did not produce a fully verified outcome",
            details=details,
        )
    track_reference = _track_reference(context, track)
    reconfigured = [
        _device_summary(
            context,
            track_reference,
            track_index,
            index,
            after_devices[index],
        )
        for index in reconfigured_indices[:BROWSER_ADDED_DEVICE_LIMIT]
    ]
    return {
        "track": {
            "index": track_index,
            "reference": track_reference,
            "name": track.name,
            "kind": _track_kind(track),
        },
        "item": item_summary,
        "before": before,
        "after": after,
        "addedDevices": [
            _device_summary(
                context,
                track_reference,
                track_index,
                before_devices.index(device)
                if device in before_devices
                else after_devices.index(device),
                device,
            )
            for device in added[:BROWSER_ADDED_DEVICE_LIMIT]
        ],
        "addedDevicesTruncated": len(added) > BROWSER_ADDED_DEVICE_LIMIT,
        "reconfiguredDevices": reconfigured,
        "reconfiguredDevicesTruncated": (
            len(reconfigured_indices) > BROWSER_ADDED_DEVICE_LIMIT
        ),
        "mutationMode": (
            "mixed"
            if added and reconfigured
            else "added"
            if added
            else "reconfigured"
        ),
        "verified": True,
    }


def register_browser_commands(registry):
    registry.register(
        "browser.inspect_roots",
        inspect_roots,
        capability="browser.inspect_roots",
        validator=_no_params,
    )
    registry.register(
        "browser.inspect_children",
        inspect_children,
        capability="browser.inspect_children",
        validator=_inspect_children_params,
    )
    registry.register(
        "browser.search",
        search,
        capability="browser.search",
        timeout_class="long",
        validator=_search_params,
    )
    registry.register(
        "browser.load_item",
        load_item,
        mutates=True,
        capability="browser.load_item",
        timeout_class="long",
        validator=_load_item_params,
    )
