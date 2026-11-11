#include "diagnostic_analyzers.hpp"
#include <algorithm>
#include <cassert>
#include <complex>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

using namespace listener::diagnostics;
using Audio = std::array<double, 2048>;
using Magnitudes = std::array<double, 1025>;

// Frozen BEFORE expanded execution. These are controlled input cases, NOT a
// certificate for every input whose estimated output falls in this interval.
constexpr std::array<double, 6> qualifiedTones{196, 220, 261.625565, 440, 880, 1760};
constexpr std::array<double, 3> amplitudes{.01, .2, .9};
constexpr std::array<double, 4> phases{0, .37, 1.3, 2.4};
constexpr double maximumCents = 20, minimumConfidence = .9;
// Scalar oracle tolerances: not a comparison against printed/golden JSON.
constexpr double spectralHzTolerance = 1e-7;
constexpr double spectralDbTolerance = 1e-5;

void require(bool condition, const std::string& context) {
  if (!condition) throw std::runtime_error(context);
}
Audio tone(double rate, double hz, double amplitude, double phase = 0) {
  Audio audio{};
  for (std::size_t i = 0; i < audio.size(); ++i)
    audio[i] = amplitude * std::sin(2 * M_PI * hz * i / rate + phase);
  return audio;
}
Audio noise() {
  Audio audio{};
  std::uint32_t random = 1234567;
  for (auto& sample : audio) {
    random = random * 1664525u + 1013904223u;
    sample = double(random) / 4294967296. * 2 - 1;
  }
  return audio;
}

struct Native {
  fluid::algorithm::STFT stft{2048, 2048, 2048, 0};
  fluid::FluidTensor<std::complex<double>, 1> spectrum;
  fluid::FluidTensor<double, 1> magnitude;
  Analyzers analyzers;
  Native() : spectrum(1025), magnitude(1025) {}
  Channel process(Audio audio, double rate) {
    stft.processFrame(fluid::RealVectorView(audio.data(), 0, 2048), spectrum);
    fluid::algorithm::STFT::magnitude(spectrum, magnitude);
    return analyzers.process(magnitude, rate);
  }
};

// Independent O(N^2) long-double DFT, not FluCoMa/HISSTools/Eigen and not the
// native test subject's magnitude buffer. The Hann and unnormalised real DFT
// specification supply the oracle. Non-bin tones avoid roundoff-floor ambiguity.
Magnitudes referenceMagnitude(const Audio& audio) {
  Magnitudes result{};
  const long double pi = std::acos(-1.L);
  for (std::size_t k = 0; k < result.size(); ++k) {
    std::complex<long double> sum{0, 0};
    for (std::size_t n = 0; n < audio.size(); ++n) {
      const auto angle = 2 * pi * n / audio.size();
      const auto weighted = audio[n] * (.5L - .5L * std::cos(angle));
      const auto phase = 2 * pi * ((k * n) % audio.size()) / audio.size();
      sum += weighted * std::complex<long double>(
        std::cos(phase), -std::sin(phase));
    }
    result[k] = static_cast<double>(std::abs(sum));
  }
  return result;
}

struct Shape { double flatness, spread, rolloff; };
Shape referenceShape(const Magnitudes& magnitudes, double rate) {
  // Pinned SpectralShape selects [0,1024), excludes Nyquist, and assigns
  // 1024 equally-spaced frequencies INCLUDING both 0 and sampleRate/2.
  constexpr std::size_t count = 1024;
  const long double floor = std::numeric_limits<double>::epsilon();
  long double mass = 0, logSum = 0, firstMoment = 0;
  for (std::size_t k = 0; k < count; ++k) {
    const long double weight = std::max<long double>(magnitudes[k], floor);
    mass += weight;
    logSum += std::log(weight);
    firstMoment += weight * rate * k / (2.L * (count - 1));
  }
  const auto center = firstMoment / mass;
  long double secondMoment = 0, cumulative = 0, rolloff = 0;
  bool crossed = false;
  for (std::size_t k = 0; k < count; ++k) {
    const long double weight = std::max<long double>(magnitudes[k], floor);
    const long double frequency = rate * k / (2.L * (count - 1));
    secondMoment += weight * (frequency - center) * (frequency - center);
    const auto previous = cumulative;
    cumulative += weight;
    if (!crossed && cumulative >= .95L * mass) {
      const auto fraction = (.95L * mass - previous) / weight;
      rolloff = k == 0 ? 0 : rate * (k - 1 + fraction) / (2.L * (count - 1));
      crossed = true;
    }
  }
  return {
    static_cast<double>(20 * std::log10(std::max(
      std::exp(logSum / count) / (mass / count), floor))),
    static_cast<double>(std::sqrt(secondMoment / mass)),
    static_cast<double>(rolloff)
  };
}
void checkShape(const Channel& actual, const Shape& expected, const std::string& name) {
  std::cout << name << " deltaDb=" << actual.flatnessDb - expected.flatness
            << " deltaSpreadHz=" << actual.spreadHz - expected.spread
            << " deltaRolloffHz=" << actual.rolloffHz - expected.rolloff << std::endl;
  require(actual.spectral == Validity::valid, name + " spectral state");
  require(std::abs(actual.flatnessDb - expected.flatness) <= spectralDbTolerance,
          name + " flatness oracle actual=" + std::to_string(actual.flatnessDb) +
          " expected=" + std::to_string(expected.flatness));
  require(std::abs(actual.spreadHz - expected.spread) <= spectralHzTolerance,
          name + " spread oracle");
  require(std::abs(actual.rolloffHz - expected.rolloff) <= spectralHzTolerance,
          name + " rolloff oracle");
}

int main() {
  std::cout << std::setprecision(17);
  std::size_t acceptedCases = 0, spectralCases = 0;
  double worstCents = 0, lowestConfidence = 1;
  for (double rate : {44100., 48000.}) {
    Native native;
    for (double hz : qualifiedTones)
      for (double amplitude : amplitudes)
        for (double phase : phases) {
          const auto out = native.process(tone(rate, hz, amplitude, phase), rate);
          const auto cents = 1200 * std::log2(out.hz / hz);
          const auto context = "sine rate=" + std::to_string(rate) +
            " hz=" + std::to_string(hz) + " amplitude=" +
            std::to_string(amplitude) + " phase=" + std::to_string(phase) +
            " cents=" + std::to_string(cents) +
            " confidence=" + std::to_string(out.confidence);
          require(std::isfinite(cents) && std::abs(cents) <= maximumCents, context);
          require(out.confidence >= minimumConfidence, context);
          require(out.pitch == Validity::acceptedEstimate, context + " gate");
          worstCents = std::max(worstCents, std::abs(cents));
          lowestConfidence = std::min(lowestConfidence, out.confidence);
          ++acceptedCases;
        }

    // Test the dangerous counterexample explicitly: high confidence, accepted
    // OUTPUT, but one octave wrong. The gate cannot recognize the input class.
    const auto octave = native.process(tone(rate, 2000, .5), rate);
    require(octave.pitch == Validity::acceptedEstimate &&
            octave.confidence > .99 && std::abs(octave.hz - 1000) < 1,
            "2000Hz high-confidence octave counterexample changed");
    std::cout << "octave-counterexample rate=" << rate << " input=2000 output="
              << octave.hz << " confidence=" << octave.confidence << "\n";
    for (double hz : {50., 65.406, 82.407, 110., 130.813}) {
      const auto low = native.process(tone(rate, hz, .5), rate);
      require(low.pitch != Validity::acceptedEstimate, "low note must not be accepted");
      require(low.hz >= 0 && low.confidence >= 0, "retain low-note raw estimate");
    }
    auto broadband = noise();
    const auto noisy = native.process(broadband, rate);
    require(noisy.pitch == Validity::lowConfidence && noisy.confidence < .2,
            "deterministic broadband rejection");
    auto noisyTone = tone(rate, 440, .1);
    for (std::size_t i = 0; i < 2048; ++i) noisyTone[i] += .1 * broadband[i];
    require(native.process(noisyTone, rate).pitch == Validity::lowConfidence,
            "deterministic noisy-tone rejection");
    auto harmonic = tone(rate, 220, .2);
    auto second = tone(rate, 440, .4);
    auto third = tone(rate, 660, .1);
    auto multitone = tone(rate, 440, .2);
    auto unrelated = tone(rate, 697, .3);
    for (std::size_t i = 0; i < 2048; ++i) {
      harmonic[i] += second[i] + third[i];
      multitone[i] += unrelated[i];
    }
    // Harmonic input is a limitation probe, not a polyphonic accuracy claim.
    const auto h = native.process(harmonic, rate);
    require(std::isfinite(h.hz) && std::isfinite(h.confidence), "harmonic finite");
    const auto multi = native.process(multitone, rate);
    require(multi.pitch != Validity::acceptedEstimate, "selected multitone rejection");
    std::cout << "harmonic-probe rate=" << rate << " hz=" << h.hz
              << " confidence=" << h.confidence << "\n";

    // One instance sequentially processes independent channels. A silent right
    // frame cannot retain the previous left value, nor can later left frames
    // be affected by right-channel history.
    const auto left = native.process(tone(rate, 440, .2), rate);
    const auto right = native.process(tone(rate, 880, .01, 1.3), rate);
    require(std::abs(left.hz - 440) < 1 && std::abs(right.hz - 880) < 1,
            "independent channels");
    const auto silent = native.process(Audio{}, rate);
    require(silent.pitch == Validity::silence && silent.spectral == Validity::silence,
            "silence unavailable descriptors");
    const auto leftAgain = native.process(tone(rate, 440, .2), rate);
    require(left.hz == leftAgain.hz && left.flatnessDb == leftAgain.flatnessDb,
            "no cross-channel or silence state retention");
    native.analyzers.failPitchForTesting = true;
    const auto pitchFailed = native.process(tone(rate, 440, .2), rate);
    require(pitchFailed.pitch == Validity::invalid &&
            pitchFailed.spectral == Validity::valid, "pitch-local exception isolation");
    native.analyzers.failPitchForTesting = false;
    native.analyzers.failShapeForTesting = true;
    const auto shapeFailed = native.process(tone(rate, 440, .2), rate);
    require(shapeFailed.pitch == Validity::acceptedEstimate &&
            shapeFailed.spectral == Validity::invalid, "spectral-local exception isolation");
    native.analyzers.failShapeForTesting = false;
    for (const auto& audio : {tone(rate, 440, .2, .37), multitone, harmonic,
                              broadband, noisyTone}) {
      checkShape(native.process(audio, rate),
                 referenceShape(referenceMagnitude(audio), rate), "DFT signal");
      ++spectralCases;
    }

    // Analytic magnitude fixtures isolate floor, weighting, Nyquist exclusion,
    // grid and rolloff interpolation from FFT floating-point cancellation.
    for (int fixture = 0; fixture < 3; ++fixture) {
      Magnitudes mag{};
      if (fixture == 0) { mag[9] = 256; mag[10] = 512; mag[11] = 256; }
      if (fixture == 1) { mag.fill(1); mag[1024] = 1e5; }
      if (fixture == 2) { mag[1] = 1; mag[37] = 3; mag[600] = 8; }
      checkShape(native.analyzers.process(
          fluid::RealVectorView(mag.data(), 0, 1025), rate),
        referenceShape(mag, rate), "analytic magnitude");
      ++spectralCases;
    }
    Magnitudes bad{};
    bad[1] = std::numeric_limits<double>::quiet_NaN();
    auto invalid = native.analyzers.process(
      fluid::RealVectorView(bad.data(), 0, 1025), rate);
    require(invalid.pitch == Validity::invalid &&
            invalid.spectral == Validity::invalid, "nonfinite rejected");
    bad[1] = -1;
    require(native.analyzers.process(fluid::RealVectorView(bad.data(), 0, 1025), rate)
              .spectral == Validity::invalid, "negative magnitude rejected");
    bad[1] = 64 * 2048 + 1;
    require(native.analyzers.process(fluid::RealVectorView(bad.data(), 0, 1025), rate)
              .spectral == Validity::invalid, "magnitude bound");
    bad.fill(std::numeric_limits<double>::epsilon());
    require(native.analyzers.process(fluid::RealVectorView(bad.data(), 0, 1025), rate)
              .spectral == Validity::undefined, "floor-only descriptors unavailable");
    bad.fill(0);
    bad[1024] = 512;
    require(native.analyzers.process(fluid::RealVectorView(bad.data(), 0, 1025), rate)
              .spectral == Validity::undefined, "excluded Nyquist-only unavailable");
  }
  std::cout << "PASS sineCases=" << acceptedCases << " worstAbsCents=" << worstCents
            << " minimumConfidence=" << lowestConfidence
            << " independentSpectralOracleCases=" << spectralCases << "\n";
}
