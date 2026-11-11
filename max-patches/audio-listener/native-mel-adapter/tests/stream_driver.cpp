// Offline synthetic-signal driver. Not a playback, recording, or product route.
#include "mel_engine.hpp"
#include <iomanip>
#include <iostream>
#include <vector>

using namespace listener::mel;
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  const double rate = std::stod(argv[1]);
  const std::size_t block = std::stoul(argv[2]);
  if (!block || block > 65536) return 2;
  Engine engine(rate);
  engine.dspSetup(rate, true);
  if (!engine.arm(1)) return 3;
  std::array<std::vector<double>, 10> inputs;
  for (auto& v : inputs) v.resize(block);
  auto drain = [&] {
    Record r;
    while (engine.drain(r)) {
      std::cout << std::setprecision(17) << "{\"kind\":" << int(r.kind)
                << ",\"reason\":" << int(r.reason) << ",\"epoch\":" << r.epoch
                << ",\"sequence\":" << r.sequence << ",\"start\":" << r.start
                << ",\"end\":" << r.end << ",\"lost\":" << r.lost
                << ",\"partial\":" << r.partial << ",\"left\":[";
      for (std::size_t i = 0; i < bands; ++i) {
        if (i) std::cout << ',';
        std::cout << r.left[i];
      }
      std::cout << "],\"right\":[";
      for (std::size_t i = 0; i < bands; ++i) {
        if (i) std::cout << ',';
        std::cout << r.right[i];
      }
      std::cout << "],\"diagnostics\":[";
      for (std::size_t channel = 0; channel < 2; ++channel) {
        if (channel) std::cout << ',';
        const auto& d = r.diagnostics[channel];
        std::cout << "{\"pitchState\":" << int(d.pitch)
                  << ",\"spectralState\":" << int(d.spectral);
        const char* keys[] = {"hz", "confidence", "flatnessDb", "spreadHz", "rolloffHz"};
        const double values[] = {d.hz, d.confidence, d.flatnessDb, d.spreadHz, d.rolloffHz};
        for (std::size_t i = 0; i < 5; ++i) {
          std::cout << ",\"" << keys[i] << "\":";
          if (std::isfinite(values[i])) std::cout << values[i];
          else std::cout << "null";
        }
        std::cout << '}';
      }
      std::cout << "]";
      if (r.kind == Kind::stopped && r.reason == Reason::sourceIdentity) {
        std::cout << ",\"sourceIdentity\":[";
        for (std::size_t i = 0; i < r.sourceIdentity.size(); ++i) {
          if (i) std::cout << ',';
          if (std::isfinite(r.sourceIdentity[i])) std::cout << r.sourceIdentity[i];
          else std::cout << "null";
        }
        std::cout << ']';
      }
      if (r.kind == Kind::stopped) {
        const auto receipt = engine.drainReceipt();
        std::cout << ",\"drainReceipt\":{\"terminal\":" << receipt.terminal
                  << ",\"clockValid\":" << receipt.clockValid
                  << ",\"clockExclusive\":" << receipt.clockExclusive
                  << ",\"records\":" << receipt.records
                  << ",\"frames\":" << receipt.frames << '}';
      }
      std::cout << "}\n";
    }
  };
  std::size_t count = 0;
  auto process = [&](std::size_t size) {
    engine.process({inputs[0].data(), inputs[1].data(), inputs[2].data(),
                    inputs[3].data(), inputs[4].data(), inputs[5].data(),
                    inputs[6].data(), inputs[7].data(), inputs[8].data(),
                    inputs[9].data()}, size);
  };
  while (std::cin >> inputs[0][count] >> inputs[1][count] >> inputs[2][count]
                  >> inputs[3][count] >> inputs[4][count] >> inputs[5][count]
                  >> inputs[6][count] >> inputs[7][count] >> inputs[8][count]
                  >> inputs[9][count]) {
    if (++count == block) {
      process(count);
      drain();
      count = 0;
    }
  }
  if (!std::cin.eof()) return 4;
  if (count) {
    process(count);
    drain();
  }
  engine.stop(1);
  // Stop ack must come from another physical perform; no new sample is read.
  process(1);
  drain();
}
