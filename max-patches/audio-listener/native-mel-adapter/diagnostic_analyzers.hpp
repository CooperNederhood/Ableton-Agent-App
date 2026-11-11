#pragma once

#include <flucoma/algorithms/public/YinFFT.hpp>
#include <flucoma/algorithms/public/SpectralShape.hpp>
#include <flucoma/algorithms/public/STFT.hpp>
#include <array>
#include <cmath>
#include <limits>

namespace listener::diagnostics {

// Fixed selected profile, not a configurable analyzer framework. Both algorithms
// consume the same independent-channel periodic-Hann magnitude frame as mel.
enum class Validity : unsigned { valid = 0, silence = 1, undefined = 2,
                                lowConfidence = 3, outsideQualifiedRange = 4,
                                invalid = 5, acceptedEstimate = 6 };
constexpr double testedMinimumHz = 196, testedMaximumHz = 1760;
constexpr double testedToleranceCents = 20, confidenceThreshold = .9;
inline const double gateMinimumHz = testedMinimumHz * std::pow(2., -20. / 1200.);
inline const double gateMaximumHz = testedMaximumHz * std::pow(2., 20. / 1200.);
struct Channel {
  // Unavailable fields have no numeric value. A future wire encoder maps
  // nonfinite internals to JSON null, never to a measured zero.
  double hz{std::numeric_limits<double>::quiet_NaN()};
  double confidence{std::numeric_limits<double>::quiet_NaN()};
  double flatnessDb{std::numeric_limits<double>::quiet_NaN()};
  double spreadHz{std::numeric_limits<double>::quiet_NaN()};
  double rolloffHz{std::numeric_limits<double>::quiet_NaN()};
  Validity pitch{Validity::invalid}, spectral{Validity::invalid};
};

class Analyzers {
public:
#ifdef LISTENER_ANALYZER_TEST_FAULTS
  bool failPitchForTesting = false, failShapeForTesting = false;
#endif
  Analyzers() : yin(1025), shape(fluid::FluidDefaultAllocator()),
                pitchResult(2), shapeResult(7) {}

  Channel process(fluid::RealVectorView magnitude, double rate) noexcept {
    Channel out;
    if (magnitude.size() != 1025 || (rate != 44100 && rate != 48000)) return out;
    bool silence = true;
    bool selectedAboveFloor = false;
    for (fluid::index i = 0; i < magnitude.size(); ++i) {
      if (!std::isfinite(magnitude(i)) || magnitude(i) < 0 ||
          magnitude(i) > 64 * 2048) return out;
      silence = silence && magnitude(i) == 0;
      selectedAboveFloor = selectedAboveFloor ||
        (i < 1024 && magnitude(i) > std::numeric_limits<double>::epsilon());
    }
    // The pinned shape algorithm floors magnitudes and returns plausible
    // broadband values for silence. Those are undefined, not measurements.
    if (silence) {
      out.pitch = out.spectral = Validity::silence;
      return out;
    }
    try {
#ifdef LISTENER_ANALYZER_TEST_FAULTS
    if (failPitchForTesting) throw 1;
#endif
    yin.processFrame(magnitude, pitchResult, 50, 2000, rate);
    out.hz = pitchResult(0);
    out.confidence = pitchResult(1);
    if (!std::isfinite(out.hz) || !std::isfinite(out.confidence) ||
        out.hz < 0 || out.hz > 24000 || out.confidence < 0 || out.confidence > 1) {
      // Keep raw finite values even on invalid output. The transport maps each
      // nonfinite value to null; it must not serialize NaN or fabricate zero.
    } else {
      out.pitch = out.hz == 0 ? Validity::undefined :
        out.confidence < confidenceThreshold ? Validity::lowConfidence :
        out.hz < gateMinimumHz || out.hz > gateMaximumHz
          ? Validity::outsideQualifiedRange : Validity::acceptedEstimate;
    }
    } catch (...) { /* pitch-local failure cannot suppress spectral shape */ }
    if (!selectedAboveFloor) {
      out.spectral = Validity::undefined;
      return out;
    }
    try {
#ifdef LISTENER_ANALYZER_TEST_FAULTS
    if (failShapeForTesting) throw 1;
#endif
    shape.processFrame(magnitude, shapeResult, rate, 0, -1, 95, false,
                       false, fluid::FluidDefaultAllocator());
    out.flatnessDb = shapeResult(5);
    out.spreadHz = shapeResult(1);
    out.rolloffHz = shapeResult(4);
    if (std::isfinite(out.flatnessDb) && out.flatnessDb <= 1e-10 &&
        out.flatnessDb >= 20 * std::log10(std::numeric_limits<double>::epsilon()) &&
        std::isfinite(out.spreadHz) && out.spreadHz >= 0 &&
        out.spreadHz <= rate / 2 && std::isfinite(out.rolloffHz) &&
        out.rolloffHz >= 0 && out.rolloffHz <= rate / 2) {
      out.spectral = Validity::valid;
    } else {
      out.flatnessDb = out.spreadHz = out.rolloffHz = 0;
    }
    } catch (...) { /* retain paired pitch if the shape analyzer fails */ }
    return out;
  }
private:
  fluid::algorithm::YINFFT yin;
  fluid::algorithm::SpectralShape shape;
  fluid::FluidTensor<double, 1> pitchResult, shapeResult;
};
} // namespace listener::diagnostics
