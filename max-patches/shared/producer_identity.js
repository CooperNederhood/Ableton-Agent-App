/* global autowatch: writable, inlets: writable, outlets: writable, LiveAPI, post, outlet, Task, jsarguments */
/* eslint no-unused-vars: "off" */
autowatch = 1;
inlets = 1;
outlets = 1;

var MAX_RETRIES = 20;
var RETRY_DELAY_MS = 250;
var generation = 0;
var retryTask = null;
var refreshTask = null;
var lastIdentity = null;
var watchPlacement =
  typeof jsarguments !== "undefined" && jsarguments[1] === "watch";
var REFRESH_DELAY_MS = 500;

function cleanValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Array) {
    return value.join(" ");
  }
  return String(value);
}

function numericId(api) {
  var value = Number(api && api.id);
  return isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function apiName(api) {
  try {
    return cleanValue(api.get("name"));
  } catch (error) {
    return "";
  }
}

function apiPath(api) {
  try {
    return cleanValue(api.unquotedpath || api.path);
  } catch (error) {
    return "";
  }
}

function apiType(api) {
  try {
    return cleanValue(api.type);
  } catch (error) {
    return "";
  }
}

function trackIndex(path) {
  var match = String(path).match(/(?:^| )tracks (\d+)(?: |$)/);
  return match ? Number(match[1]) : null;
}

function makeApi(path) {
  try {
    return new LiveAPI(path);
  } catch (firstError) {
    try {
      return new LiveAPI(function () {}, path);
    } catch (secondError) {
      post(
        "[midi_capture_identity] LiveAPI " +
          path +
          ": " +
          String(
            secondError && secondError.message
              ? secondError.message
              : secondError
          ) +
          "\n"
      );
      return null;
    }
  }
}

function findTrack() {
  var path = "live_set this_device canonical_parent";
  for (var depth = 0; depth < 16; depth += 1) {
    var api = makeApi(path);
    if (!numericId(api)) {
      return null;
    }
    if (apiType(api) === "Track") {
      return api;
    }
    path += " canonical_parent";
  }
  return null;
}

function buildIdentity() {
  var deviceApi = makeApi("live_set this_device");
  var deviceId = numericId(deviceApi);
  var canonicalPath = apiPath(deviceApi);
  var deviceName = apiName(deviceApi);
  if (!deviceId || !canonicalPath || !deviceName) {
    return null;
  }

  var trackApi = findTrack();
  if (!trackApi) {
    return null;
  }
  var trackId = numericId(trackApi);
  var trackPath = apiPath(trackApi);
  var trackName = apiName(trackApi);
  if (!trackId || !trackPath || !trackName) {
    return null;
  }

  var track = {
    id: trackId,
    name: trackName
  };
  var index = trackIndex(trackPath);
  if (index !== null) {
    track.index = index;
  }

  return {
    canonicalPath: canonicalPath,
    track: track,
    device: {
      id: deviceId,
      name: deviceName
    }
  };
}

function cancelRetry() {
  if (retryTask) {
    retryTask.cancel();
    retryTask = null;
  }
}

function publishIdentity(identity, force) {
  var encoded = identity ? JSON.stringify(identity) : null;
  if (encoded === lastIdentity && !force) return;
  lastIdentity = encoded;
  if (encoded !== null) outlet(0, "identity", encoded);
  else outlet(0, "identity-unavailable");
}

function refresh(requestGeneration) {
  if (requestGeneration !== generation) return;
  refreshTask = null;
  try {
    publishIdentity(buildIdentity(), false);
  } catch (error) {
    publishIdentity(null, false);
    post("[producer_identity] placement refresh failed\n");
  }
  scheduleRefresh(requestGeneration);
}

function scheduleRefresh(requestGeneration) {
  if (!watchPlacement || requestGeneration !== generation || refreshTask)
    return;
  refreshTask = new Task(refresh, this, requestGeneration);
  refreshTask.schedule(REFRESH_DELAY_MS);
}

function attempt(requestGeneration, retryCount) {
  if (requestGeneration !== generation) {
    return;
  }

  var identity = buildIdentity();
  if (identity) {
    retryTask = null;
    publishIdentity(identity, true);
    scheduleRefresh(requestGeneration);
    return;
  }

  if (retryCount >= MAX_RETRIES) {
    retryTask = null;
    post(
      "[midi_capture_identity] LiveAPI identity unavailable after " +
        MAX_RETRIES +
        " retries\n"
    );
    return;
  }

  retryTask = new Task(attempt, this, requestGeneration, retryCount + 1);
  retryTask.schedule(RETRY_DELAY_MS);
}

function bang() {
  try {
    generation += 1;
    cancelRetry();
    if (refreshTask) {
      refreshTask.cancel();
      refreshTask = null;
    }
    if (watchPlacement) {
      var identity = buildIdentity();
      publishIdentity(identity, true);
      scheduleRefresh(generation);
    } else {
      attempt(generation, 0);
    }
  } catch (error) {
    if (watchPlacement) {
      publishIdentity(null, true);
      scheduleRefresh(generation);
      post("[producer_identity] placement unavailable\n");
      return;
    }
    post(
      "[midi_capture_identity] " +
        String(error && error.message ? error.message : error) +
        "\n"
    );
  }
}

function notifydeleted() {
  generation += 1;
  cancelRetry();
  if (refreshTask) {
    refreshTask.cancel();
    refreshTask = null;
  }
}
