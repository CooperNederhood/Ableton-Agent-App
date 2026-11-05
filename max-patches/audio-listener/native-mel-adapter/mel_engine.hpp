#pragma once

#include <flucoma/data/TensorTypes.hpp>
#include <flucoma/algorithms/public/MelBands.hpp>
#include <flucoma/algorithms/public/STFT.hpp>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <stdexcept>

namespace listener::mel {

constexpr std::size_t window = 2048, bands = 24, bins = 1025;
constexpr std::uint64_t clockLimit = 1ULL << 44;
constexpr std::size_t queueCapacity = 64;

enum class Kind : std::uint64_t { started = 1, frame = 2, stopped = 3, ready = 4 };
enum class Reason : std::uint64_t {
  none = 0, requested = 1, sourceStopped = 2, clockDiscontinuity = 3,
  sourceIdentity = 4, nonfiniteAudio = 5, overflow = 6,
  nonfiniteResult = 7, handshakeTimeout = 8, dspChanged = 9,
  complete = 10, originUnavailable = 11
};

struct Signals {
  const double *left, *right, *clock, *epoch, *rejected;
  const double *origin, *abi, *total, *vector, *sealed;
};

struct Record {
  Kind kind{};
  Reason reason{};
  std::uint64_t epoch{}, generation{}, sequence{}, start{}, end{};
  std::uint64_t lost{}, partial{};
  std::uint64_t receiptClock{};
  bool receiptValid{};
  double sampleRate{};
  std::array<double, bands> left{}, right{};
};

struct DrainReceipt {
  std::uint64_t epoch{}, generation{}, records{}, frames{};
  bool terminal{}, clockValid{};
  std::uint64_t clockExclusive{};
};

// Exactly one audio producer and one serialized control consumer. Terminal
// records use the reserved final slot, so a full frame FIFO cannot hide loss.
class Records {
public:
  bool push(const Record& value, bool terminal = false) noexcept {
    auto w = write.load(std::memory_order_relaxed);
    auto r = read.load(std::memory_order_acquire);
    if (w - r >= queueCapacity - (terminal ? 0 : 1)) return false;
    data[w % queueCapacity] = value;
    write.store(w + 1, std::memory_order_release);
    return true;
  }
  bool pop(Record& value) noexcept {
    auto r = read.load(std::memory_order_relaxed);
    if (r == write.load(std::memory_order_acquire)) return false;
    value = data[r % queueCapacity];
    read.store(r + 1, std::memory_order_release);
    return true;
  }
private:
  std::array<Record, queueCapacity> data{};
  alignas(64) std::atomic<std::uint64_t> read{0};
  alignas(64) std::atomic<std::uint64_t> write{0};
};

// Fixed-profile direct use of pinned core algorithms. No stock Max wrapper,
// BufferedProcess retained output, callbacks counted as frames, or PCM export.
class Engine {
public:
  explicit Engine(double rate)
      : sampleRate(rate), stft(window, window, window, 0), mel(bands, window),
        spectrum(bins), magnitude(bins), result(bands) {
    if (rate != 44100 && rate != 48000)
      throw std::invalid_argument("capture source requires 44100 or 48000 Hz");
    mel.init(20., 20000., bands, bins, rate, window);
  }

  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  // CONTROL thread only. Re-arm is forbidden until the previous terminal
  // record was drained. Stale epochs can never resurrect a stopped session.
  bool arm(std::uint64_t epoch) noexcept {
    if (busy || epoch <= highWater || epoch >= clockLimit) return false;
    highWater = epoch;
    busy = true;
    consumed = {};
    consumed.epoch = epoch;
    stopEpoch.store(0, std::memory_order_relaxed);
    requestEpoch.store(epoch, std::memory_order_release);
    return true;
  }
  bool stop(std::uint64_t epoch) noexcept {
    if (!busy || epoch != highWater) return false;
    stopEpoch.store(epoch, std::memory_order_release);
    return true;
  }
  bool drain(Record& value) noexcept {
    if (!records.pop(value)) return false;
    consumed.generation = value.generation;
    ++consumed.records;
    if (value.kind == Kind::frame) ++consumed.frames;
    if (value.kind == Kind::stopped) {
      busy = false;
      consumed.terminal = true;
      consumed.clockValid = value.receiptValid;
      consumed.clockExclusive = value.receiptValid ? value.receiptClock : 0;
    }
    return true;
  }
  // CONTROL only. This is separate from timeline structure and does not
  // claim queue quiescence until the reserved terminal was actually consumed.
  DrainReceipt drainReceipt() const noexcept { return consumed; }

  // Called by dsp64, only while Max has suspended this object's perform.
  // Never acknowledges stop here. A rebuild while armed faults on the next
  // real perform, including an otherwise identical DSP rebuild.
  void dspSetup(double rate, bool connected) noexcept {
    ++generation;
    bindingValid = connected && rate == sampleRate;
  }

  // AUDIO thread only. All ten vectors must belong to this same perform64.
  // Header sample coordinates are read from the native source signal, not
  // constructed by incrementing host callbacks. end is exclusive.
  void process(const Signals& s, std::size_t size) noexcept {
    auto requested = requestEpoch.load(std::memory_order_acquire);
    if (!active && requested != accepted) {
      accepted = requested;
      active = true;
      begun = false;
      ready = false;
      used = 0;
      completed = 0;
      waited = 0;
      haveClock = false;
      retained = 0;
      captureStart = captureEnd = captureVector = 0;
      captureGeneration = generation;
    }
    if (!active || size == 0) return;
    receiptValid = false;
    if (stopEpoch.load(std::memory_order_acquire) == accepted) {
      if (bindingValid && generation == captureGeneration &&
          integer(s.clock[0]) && (!haveClock || s.clock[0] == nextClock) &&
          s.epoch[0] == accepted && s.sealed[0] == accepted &&
          s.abi[0] == 3 && s.rejected[0] == 0) {
        receiptValid = true;
        receiptClock = static_cast<std::uint64_t>(s.clock[0]) + 1;
      }
      finish(Reason::requested);
      return;
    }
    if (!bindingValid || generation != captureGeneration) {
      finish(Reason::dspChanged);
      return;
    }
    for (std::size_t i = 0; i < size && active; ++i) {
      receiptValid = false;
      if (!integer(s.clock[i]) || (haveClock && s.clock[i] != nextClock)) {
        finish(Reason::clockDiscontinuity);
        break;
      }
      const auto now = static_cast<std::uint64_t>(s.clock[i]);
      nextClock = now + 1;
      haveClock = true;
      if (s.abi[i] != 3 || !integer(s.epoch[i]) ||
          s.epoch[i] > accepted || (begun && s.epoch[i] != accepted)) {
        finish(Reason::sourceIdentity);
        break;
      }
      if (s.epoch[i] == accepted &&
          (s.rejected[i] != 0 || !integer(s.sealed[i]))) {
        finish(Reason::sourceIdentity);
        break;
      }
      if (begun && (s.sealed[i] != accepted || s.origin[i] != captureStart ||
                    s.total[i] != captureEnd - captureStart ||
                    s.vector[i] != captureVector)) {
        finish(Reason::sourceStopped);
        break;
      }
      if (s.epoch[i] == accepted && s.sealed[i] == accepted) {
        receiptValid = true;
        receiptClock = nextClock;
      }
      if (!begun) {
        // A 1024-sample retrospective origin plus the current sample. Only
        // transient RAM; no scheduler-side audio access or persistence.
        historyL[now % historySize] = s.left[i];
        historyR[now % historySize] = s.right[i];
        retained = std::min(historySize, retained + 1);
      }
      if (!begun && s.epoch[i] == accepted && s.sealed[i] == accepted) {
        if (!integer(s.total[i]) || s.total[i] < 1 ||
            s.total[i] > sampleRate * 30 || !integer(s.vector[i]) ||
            s.vector[i] < 1 || s.vector[i] > 1024 ||
            (static_cast<std::uint64_t>(s.vector[i]) &
             (static_cast<std::uint64_t>(s.vector[i]) - 1))) {
          finish(Reason::sourceIdentity);
          break;
        }
        if (!ready && s.origin[i] == -1 && retained > s.vector[i]) {
          Record receipt = header(Kind::ready);
          receipt.start = receipt.end = nextClock;
          if (!records.push(receipt)) { finish(Reason::overflow); break; }
          ready = true;
        }
      }
      if (s.epoch[i] != accepted || s.sealed[i] != accepted || s.origin[i] == -1) {
        if (++waited > static_cast<std::uint64_t>(sampleRate * 10))
          finish(Reason::handshakeTimeout);
        continue;
      }
      if (!begun) {
        if (!integer(s.origin[i]) || !integer(s.total[i]) || s.total[i] == 0 ||
            !integer(s.vector[i]) || s.vector[i] < 1 || s.vector[i] > 1024) {
          finish(Reason::sourceIdentity);
          break;
        }
        const auto origin = static_cast<std::uint64_t>(s.origin[i]);
        const auto total = static_cast<std::uint64_t>(s.total[i]);
        const auto vector = static_cast<std::uint64_t>(s.vector[i]);
        if ((vector & (vector - 1)) || origin > now ||
            total > clockLimit - origin || total > sampleRate * 30) {
          finish(Reason::sourceIdentity);
          break;
        }
        if (now - origin > vector || now - origin >= retained) {
          finish(Reason::originUnavailable);
          break;
        }
        begun = true;
        captureStart = frameStart = origin;
        captureEnd = origin + total;
        captureVector = vector;
        Record start = header(Kind::started);
        start.start = captureStart;
        start.end = captureEnd;
        // Empty by the arm/drain contract, with a reserved terminal slot.
        if (!records.push(start)) { finish(Reason::overflow); break; }
        for (auto sample = origin; sample <= now && active; ++sample) {
          acceptSample(historyL[sample % historySize],
                       historyR[sample % historySize], sample);
        }
      } else {
        acceptSample(s.left[i], s.right[i], now);
      }
    }
  }

private:
  static bool integer(double value) noexcept {
    return std::isfinite(value) && value >= 0 && value < clockLimit &&
           std::floor(value) == value;
  }
  static bool finite(const std::array<double, bands>& values) noexcept {
    for (auto v : values) if (!std::isfinite(v) || v < 0) return false;
    return true;
  }
  Record header(Kind kind) const noexcept {
    Record r{};
    r.kind = kind;
    r.epoch = accepted;
    r.generation = captureGeneration;
    r.sampleRate = sampleRate;
    r.receiptValid = receiptValid;
    r.receiptClock = receiptValid ? receiptClock : 0;
    return r;
  }
  void finish(Reason reason) noexcept {
    Record r = header(Kind::stopped);
    r.reason = reason;
    r.sequence = completed;
    r.start = begun ? captureStart + completed * window : 0;
    r.end = begun ? captureEnd : 0;
    r.partial = begun ? (captureEnd - captureStart) % window : 0;
    r.lost = begun ? (captureEnd - captureStart) / window - completed : 0;
    active = false;
    used = 0;
    audioL.fill(0);
    audioR.fill(0);
    historyL.fill(0);
    historyR.fill(0);
    // Production is already quiescent and PCM erased BEFORE publishing ack.
    // At most one terminal per arm; nonterminal pushes reserve its slot.
    const bool delivered = records.push(r, true);
    assert(delivered);
    (void)delivered;
  }
  void acceptSample(double left, double right, std::uint64_t sample) noexcept {
    if (!std::isfinite(left) || !std::isfinite(right) ||
        std::abs(left) > 64 || std::abs(right) > 64) {
      finish(Reason::nonfiniteAudio);
      return;
    }
    audioL[used] = left;
    audioR[used] = right;
    if (++used == window) {
      // Actual full-frame completion, aligned to the executed capture origin.
      Record frame = header(Kind::frame);
      frame.sequence = completed + 1;
      frame.start = frameStart;
      frame.end = sample + 1;
      analyse(audioL, frame.left);
      analyse(audioR, frame.right);
      if (!finite(frame.left) || !finite(frame.right)) {
        finish(Reason::nonfiniteResult);
        return;
      }
      if (!records.push(frame)) {
        finish(Reason::overflow);
        return;
      }
      ++completed;
      used = 0;
      frameStart = sample + 1;
    }
    if (sample + 1 == captureEnd) finish(Reason::complete);
  }
  void analyse(std::array<double, window>& audio,
               std::array<double, bands>& output) noexcept {
    fluid::RealVectorView view(audio.data(), 0, window);
    stft.processFrame(view, spectrum);
    fluid::algorithm::STFT::magnitude(spectrum, magnitude);
    mel.processFrame(magnitude, result, false, false, false,
                     fluid::FluidDefaultAllocator());
    for (std::size_t i = 0; i < bands; ++i) output[i] = result(i);
  }

  double sampleRate;
  fluid::algorithm::STFT stft;
  fluid::algorithm::MelBands mel;
  fluid::FluidTensor<std::complex<double>, 1> spectrum;
  fluid::FluidTensor<double, 1> magnitude, result;
  std::array<double, window> audioL{}, audioR{};
  static constexpr std::size_t historySize = 1025;
  std::array<double, historySize> historyL{}, historyR{};
  Records records;
  std::atomic<std::uint64_t> requestEpoch{0}, stopEpoch{0};
  // Control-owned:
  std::uint64_t highWater{0};
  bool busy{false};
  DrainReceipt consumed{};
  // Audio-owned (dspSetup runs only with perform suspended):
  bool active{false}, begun{false}, ready{false}, haveClock{false}, bindingValid{false};
  std::uint64_t accepted{0}, generation{0}, captureGeneration{0};
  std::uint64_t completed{0}, waited{0}, frameStart{0}, nextClock{0};
  std::uint64_t captureStart{0}, captureEnd{0}, captureVector{0};
  bool receiptValid{false};
  std::uint64_t receiptClock{0};
  std::size_t used{0}, retained{0};
};

static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
              "The RT bridge requires lock-free 64-bit atomics");
} // namespace listener::mel
