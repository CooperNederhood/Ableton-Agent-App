#include "mel_engine.hpp"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <limits>
#include <thread>
#include <vector>

using namespace listener::mel;

struct Harness {
  Engine engine{48000};
  std::uint64_t position{100000}, epoch{1};
  double gate{1}, abi{3}, origin{100000}, total{window * 100}, vector{64};
  Harness() { engine.dspSetup(48000, true); assert(engine.arm(epoch)); }
  void feed(std::size_t count, double l = 1, double r = .25) {
    std::vector<double> left(count, l), right(count, r), clocks(count),
      epochs(count, static_cast<double>(epoch)), gates(count, gate), abis(count, abi),
      origins(count, origin), totals(count, total), vectors(count, vector),
      rejections(count, 0);
    for (auto& c : clocks) c = static_cast<double>(position++);
    // The pinned Eigen path may not allocate once preparation has completed.
    Eigen::internal::set_is_malloc_allowed(false);
    engine.process({left.data(), right.data(), clocks.data(), epochs.data(),
                    rejections.data(), origins.data(), abis.data(), totals.data(),
                    vectors.data(), gates.data()}, count);
    Eigen::internal::set_is_malloc_allowed(true);
  }
  std::vector<Record> drain() {
    std::vector<Record> out;
    Record r;
    while (engine.drain(r)) out.push_back(r);
    return out;
  }
  Record stop() {
    assert(engine.stop(epoch));
    feed(64);
    auto records = drain();
    assert(!records.empty());
    auto last = records.back();
    assert(last.kind == Kind::stopped);
    return last;
  }
};

void framing() {
  Harness h;
  h.feed(2047);
  auto a = h.drain();
  assert(a.size() == 1 && a[0].kind == Kind::started && a[0].start == 100000);
  h.feed(1);
  a = h.drain();
  assert(a.size() == 1);
  const auto& f = a[0];
  assert(f.kind == Kind::frame && f.sequence == 1);
  assert(f.start == 100000 && f.end == 102048 && f.epoch == 1);
  for (std::size_t i = 0; i < bands; ++i)
    assert(std::abs(f.right[i] - f.left[i] * .25) < 1e-10);
  auto stop = h.stop();
  assert(stop.reason == Reason::requested && stop.partial == 0 && stop.lost == 99);
  assert(!h.engine.arm(1));
  assert(h.engine.arm(2));
}

void partitionInvariant() {
  Harness whole, split;
  whole.feed(window * 4 + 97);
  std::size_t remaining = window * 4 + 97;
  for (std::size_t block = 1; remaining; block = (block * 31) % 507 + 1) {
    auto count = std::min(block, remaining);
    split.feed(count);
    remaining -= count;
  }
  auto a = whole.drain(), b = split.drain();
  assert(a.size() == 5 && b.size() == a.size());
  for (std::size_t i = 0; i < a.size(); ++i) {
    assert(a[i].start == b[i].start && a[i].end == b[i].end);
    assert(a[i].left == b[i].left && a[i].right == b[i].right);
  }
  assert(whole.stop().lost == 96);
  assert(split.stop().lost == 96);
}

void physicalStopAndEpoch() {
  Harness h;
  h.feed(100);
  h.drain();
  assert(h.engine.stop(1));
  assert(h.drain().empty()); // control request is NOT a physical stop ack
  assert(!h.engine.arm(2));
  h.feed(64);
  auto a = h.drain();
  assert(a.size() == 1 && a[0].kind == Kind::stopped && a[0].lost == 100);
  h.feed(window * 2);
  assert(h.drain().empty()); // callbacks cannot resurrect this epoch
  assert(!h.engine.stop(1));
  assert(h.engine.arm(2));
  h.epoch = 2;
  h.gate = 2;
  h.origin = h.position;
  h.feed(window);
  a = h.drain();
  assert(a.size() == 2 && a[1].sequence == 1 && a[1].epoch == 2);
  assert(!h.engine.stop(1));
  h.stop();
}

void failures() {
  {
    Harness h;
    h.feed(17);
    h.position += 1;
    h.feed(window);
    auto a = h.drain();
    assert(a.size() == 2 && a.back().reason == Reason::clockDiscontinuity);
  }
  {
    Harness h;
    h.feed(17);
    h.epoch = 2;
    h.feed(1);
    assert(h.drain().back().reason == Reason::sourceIdentity);
  }
  {
    Harness h;
    h.feed(17);
    h.gate = 0;
    h.feed(1);
    assert(h.drain().back().reason == Reason::sourceStopped);
  }
  {
    Harness h;
    h.abi = 1;
    h.feed(1);
    assert(h.drain().back().reason == Reason::sourceIdentity);
  }
  {
    Harness h;
    h.feed(30, std::numeric_limits<double>::quiet_NaN());
    auto a = h.drain();
    assert(a.size() == 2 && a.back().reason == Reason::nonfiniteAudio);
  }
  {
    Harness h;
    h.feed(30);
    h.engine.dspSetup(48000, true);
    h.feed(1);
    assert(h.drain().back().reason == Reason::dspChanged);
  }
  {
    Harness h;
    h.engine.dspSetup(44100, true);
    h.feed(1);
    assert(h.drain().back().reason == Reason::dspChanged);
  }
  {
    Harness h;
    h.engine.dspSetup(48000, false);
    h.feed(1);
    assert(h.drain().back().reason == Reason::dspChanged);
  }
}

void handshakeAndBounds() {
  Harness h;
  h.epoch = 0;
  h.gate = 0;
  h.origin = -1;
  h.feed(123);
  assert(h.drain().empty());
  h.epoch = 1;
  h.gate = 1;
  h.origin = h.position;
  h.feed(window);
  auto a = h.drain();
  assert(a.size() == 2 && a[1].start == 100123 && a[1].end == 102171);
  h.stop();
  Harness timeout;
  timeout.gate = 0;
  timeout.origin = -1;
  timeout.feed(480001);
  assert(timeout.drain().back().reason == Reason::handshakeTimeout);
  Harness bound;
  bound.position = clockLimit - window;
  bound.origin = bound.position;
  bound.total = window;
  bound.feed(window);
  a = bound.drain();
  assert(a.size() == 3 && a[1].end == clockLimit);
  assert(a.back().reason == Reason::complete);
  bound.feed(1);
  assert(bound.drain().empty());
}

void overflow() {
  Harness h;
  h.feed(window * 100);
  auto a = h.drain();
  assert(a.size() == queueCapacity); // 1 start + 62 frames + reserved terminal
  assert(a.back().kind == Kind::stopped && a.back().reason == Reason::overflow);
  assert(a.back().sequence == 62 && a.back().lost == 38);
  assert(a.back().start == 100000 + 62 * window);
  assert(a.back().end == 100000 + 100 * window);
  for (std::size_t i = 1; i < a.size() - 1; ++i) {
    assert(a[i].sequence == i);
    assert(a[i].start == 100000 + (i - 1) * window);
    assert(a[i].end == 100000 + i * window);
  }
  h.feed(window);
  assert(h.drain().empty());
}

void edgeCases() {
  {
    Harness h;
    assert(!h.engine.arm(0) && !h.engine.arm(clockLimit));
    assert(!h.engine.arm(2));
    assert(h.engine.stop(1));
    // An empty perform is not physical sample execution.
    h.feed(0);
    assert(h.drain().empty());
    h.feed(1);
    auto a = h.drain();
    assert(a.size() == 1 && a[0].reason == Reason::requested);
    assert(a[0].sequence == 0 && a[0].partial == 0);
  }
  {
    Harness h;
    h.feed(window, 0, 0);
    auto a = h.drain();
    assert(a.size() == 2);
    for (auto v : a[1].left) assert(v == 0);
    for (auto v : a[1].right) assert(v == 0);
    h.stop();
  }
  {
    Harness h;
    h.feed(window, std::numeric_limits<double>::max());
    auto a = h.drain();
    assert(a.size() == 2 && a.back().reason == Reason::nonfiniteAudio);
    assert(a.back().lost == 100 && a.back().sequence == 0);
    assert(a.back().start == 100000 && a.back().end == 100000 + 100 * window);
  }
  {
    Harness h;
    h.gate = .5;
    h.feed(1);
    assert(h.drain().back().reason == Reason::sourceIdentity);
  }
  {
    bool rejected = false;
    try { Engine bad(32000); }
    catch (const std::invalid_argument&) { rejected = true; }
    assert(rejected);
  }
}

void captureOriginAndTail() {
  for (auto length : {1ULL, 2047ULL, 2048ULL, 4096ULL, 4133ULL}) {
    Harness h;
    h.origin = -1;
    h.total = length;
    h.feed(128);
    auto readiness = h.drain();
    assert(readiness.size() == 1 && readiness[0].kind == Kind::ready);
    h.origin = 100064; // resolved 64 samples retrospectively
    h.feed(static_cast<std::size_t>(length + 64));
    auto a = h.drain();
    assert(a.front().kind == Kind::started && a.front().start == 100064);
    assert(a.front().end == 100064 + length);
    assert(a.size() == length / window + 2);
    assert(a.back().reason == Reason::complete && a.back().lost == 0);
    assert(a.back().sequence == length / window);
    assert(a.back().partial == length % window);
    assert(a.back().start == 100064 + (length / window) * window);
    assert(a.back().end == 100064 + length);
    auto receipt = h.engine.drainReceipt();
    assert(receipt.terminal && receipt.clockValid);
    assert(receipt.clockExclusive >= a.back().end);
    if (length == 1) assert(receipt.clockExclusive > a.back().end);
  }
  {
    Harness h;
    h.origin = 99999; // source sample was never retained by this producer
    h.feed(1);
    auto a = h.drain();
    assert(a.size() == 1 && a[0].reason == Reason::originUnavailable);
    assert(a[0].start == 0 && a[0].end == 0);
  }
  {
    Harness h;
    h.origin = -1;
    h.vector = 1024;
    h.feed(1025);
    auto readiness = h.drain();
    assert(readiness.size() == 1 && readiness[0].kind == Kind::ready);
    h.origin = 100000; // one beyond the permitted retrospective bound
    h.feed(1);
    assert(h.drain().back().reason == Reason::originUnavailable);
  }
}

void drainCompleteness() {
  Harness h;
  h.total = window + 23;
  h.feed(window + 23);
  // Physical completion is already queued but not yet control-consumed.
  auto receipt = h.engine.drainReceipt();
  assert(!receipt.terminal && receipt.records == 0 && receipt.frames == 0);
  Record r;
  assert(h.engine.drain(r) && r.kind == Kind::started);
  assert(!h.engine.drainReceipt().terminal);
  assert(h.engine.drain(r) && r.kind == Kind::frame);
  receipt = h.engine.drainReceipt();
  assert(receipt.frames == 1 && receipt.records == 2 && !receipt.terminal);
  assert(h.engine.drain(r) && r.kind == Kind::stopped);
  receipt = h.engine.drainReceipt();
  assert(receipt.terminal && receipt.records == 3 && receipt.frames == 1);
  assert(receipt.epoch == 1 && receipt.generation == 1 && receipt.clockValid);
  assert(receipt.clockExclusive == 100000 + window + 23);
  assert(!h.engine.drain(r));
  assert(h.engine.drainReceipt().clockExclusive == receipt.clockExclusive);
  assert(h.engine.arm(2));
  receipt = h.engine.drainReceipt();
  assert(receipt.epoch == 2 && receipt.records == 0 && !receipt.terminal);
  assert(!receipt.clockValid && receipt.clockExclusive == 0);

  Harness discontinuity;
  discontinuity.feed(100);
  discontinuity.position += 1;
  discontinuity.feed(1);
  discontinuity.drain();
  receipt = discontinuity.engine.drainReceipt();
  assert(receipt.terminal && !receipt.clockValid && receipt.clockExclusive == 0);

  Harness stopping;
  stopping.feed(17);
  stopping.drain();
  assert(stopping.engine.stop(1));
  assert(!stopping.engine.drainReceipt().terminal);
  stopping.feed(1);
  stopping.drain();
  receipt = stopping.engine.drainReceipt();
  assert(receipt.terminal && receipt.clockValid && receipt.clockExclusive == 100018);
}

void fftConvention() {
  // Analytical FFT facts, not a second mel-band oracle. HTL's 2x real FFT is
  // corrected by the core's 0.5: bin-centered Hann sine amplitude is N/4.
  fluid::algorithm::STFT stft(window, window, window, 0);
  fluid::FluidTensor<double, 1> audio(window);
  fluid::FluidTensor<std::complex<double>, 1> spectrum(bins);
  for (std::size_t i = 0; i < window; ++i)
    audio(i) = std::sin(2 * std::acos(-1.) * 64 * i / window);
  stft.processFrame(audio, spectrum);
  assert(std::abs(std::abs(spectrum(64)) - 512) < 1e-9);
  assert(std::abs(std::abs(spectrum(63)) - 256) < 1e-9);
  assert(std::abs(std::abs(spectrum(65)) - 256) < 1e-9);
  assert(std::abs(stft.window()(0)) < 1e-15);
  assert(stft.window()(window - 1) > 0); // periodic, not symmetric Hann
}

void concurrentFifo() {
  Records queue;
  constexpr std::uint64_t count = 100000;
  std::thread producer([&] {
    for (std::uint64_t i = 1; i <= count; ++i) {
      Record r{};
      r.sequence = i;
      r.left.fill(static_cast<double>(i));
      while (!queue.push(r)) std::this_thread::yield();
    }
  });
  for (std::uint64_t i = 1; i <= count; ++i) {
    Record r;
    while (!queue.pop(r)) std::this_thread::yield();
    assert(r.sequence == i);
    for (auto value : r.left) assert(value == static_cast<double>(i));
  }
  producer.join();
}

void actualProbe() {
  Engine engine(48000);
  ProbeReceipt receipt;
  engine.probe(99);
  assert(!engine.probeReceipt(99, receipt)); // control is NOT execution
  engine.dspSetup(48000, true);
  double left = 0, right = 0, clock = 1234, epoch = 0, rejected = 0;
  double origin = -1, abi = 3, total = 10000, vector = 64, sealed = 0;
  engine.process({&left, &right, &clock, &epoch, &rejected, &origin, &abi,
                  &total, &vector, &sealed}, 1);
  assert(engine.probeReceipt(99, receipt));
  assert(receipt.ready && receipt.generation == 1 && receipt.sourceClock == 1234);
  assert(receipt.sampleRate == 48000);
  engine.probe(100);
  assert(!engine.probeReceipt(100, receipt));
  abi = 2;
  engine.process({&left, &right, &clock, &epoch, &rejected, &origin, &abi,
                  &total, &vector, &sealed}, 1);
  assert(engine.probeReceipt(100, receipt) && !receipt.ready);
  engine.dspSetup(48000, false);
  engine.probe(101);
  abi = 3;
  engine.process({&left, &right, &clock, &epoch, &rejected, &origin, &abi,
                  &total, &vector, &sealed}, 1);
  assert(engine.probeReceipt(101, receipt) && !receipt.ready);
}

void identityFaultEvidence() {
  // Capture exact offending-sample operands, not a later callback snapshot.
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  const std::array<std::array<double, 4>, 10> cases{{
    {2, 1, 0, 1}, {3, 2, 0, 1}, {3, 1, 14, 1}, {3, 1, 0, .5},
    {nan, 1, 0, 1}, {3, nan, 0, 1}, {3, 1, nan, 1}, {3, 1, 0, nan},
    {inf, 1, 0, 1}, {3, 1, -inf, 1}
  }};
  for (const auto& fault : cases) {
    Harness h;
    h.feed(window + 7);
    auto prior = h.drain();
    assert(prior.size() == 2);
    double left = 0, right = 0, clock = h.position;
    double abi = fault[0], epoch = fault[1], rejected = fault[2], sealed = fault[3];
    h.engine.process({&left, &right, &clock, &epoch, &rejected, &h.origin,
                      &abi, &h.total, &h.vector, &sealed}, 1);
    // Mutating all signal storage AFTER perform must not change the evidence.
    abi = epoch = rejected = sealed = -123;
    auto records = h.drain();
    assert(records.size() == 1);
    const auto& terminal = records[0];
    assert(terminal.kind == Kind::stopped && terminal.reason == Reason::sourceIdentity);
    assert(terminal.epoch == 1 && terminal.generation == 1 && terminal.sequence == 1);
    for (std::size_t i = 0; i < fault.size(); ++i)
      assert(std::isnan(fault[i]) ? std::isnan(terminal.sourceIdentity[i])
                                 : terminal.sourceIdentity[i] == fault[i]);
    assert(terminal.sourceIdentity[4] == clock);
    const auto receipt = h.engine.drainReceipt();
    assert(receipt.terminal && receipt.records == 3 && receipt.frames == 1);
    assert(!receipt.clockValid && receipt.clockExclusive == 0);
    h.engine.process({&left, &right, &clock, &epoch, &rejected, &h.origin,
                      &abi, &h.total, &h.vector, &sealed}, 1);
    assert(h.drain().empty()); // one bounded fault record, no repeated telemetry
  }
}

int main() {
  identityFaultEvidence();
  actualProbe();
  framing();
  partitionInvariant();
  physicalStopAndEpoch();
  failures();
  handshakeAndBounds();
  overflow();
  fftConvention();
  concurrentFifo();
  edgeCases();
  captureOriginAndTail();
  drainCompleteness();
  std::cout << "13 native suites passed; actual ABI3 readiness, fault operands, capture binding, drain receipt and FFT verified\n";
}
