// Application-owned Max adapter; all analysis is in the pinned FluCoMa core.
#include "ext.h"
#include "ext_obex.h"
#include "z_dsp.h"
#include "mel_engine.hpp"
#include <memory>

namespace {
using namespace listener::mel;
struct State { std::unique_ptr<Engine> engine; };
struct External { t_pxobject object; State* state; void* outlet; };
t_class* klass;

bool epochArgument(long argc, t_atom* argv, std::uint64_t& epoch) {
  if (argc != 1 || atom_gettype(argv) != A_LONG) return false;
  auto value = atom_getlong(argv);
  if (value <= 0 || static_cast<std::uint64_t>(value) >= clockLimit) return false;
  epoch = static_cast<std::uint64_t>(value);
  return true;
}

void armLow(External* x, t_symbol*, long argc, t_atom* argv) {
  std::uint64_t epoch;
  if (!epochArgument(argc, argv, epoch) || !x->state->engine ||
      !x->state->engine->arm(epoch))
    object_error(reinterpret_cast<t_object*>(x), "arm rejected (DSP, epoch, or undrained session)");
}
void stopLow(External* x, t_symbol*, long argc, t_atom* argv) {
  std::uint64_t epoch;
  if (!epochArgument(argc, argv, epoch) || !x->state->engine ||
      !x->state->engine->stop(epoch))
    object_error(reinterpret_cast<t_object*>(x), "stop rejected (epoch or no session)");
}
void drainLow(External* x, t_symbol*, long argc, t_atom* argv) {
  std::uint64_t token = 0;
  if (argc && !epochArgument(argc, argv, token)) {
    object_error(reinterpret_cast<t_object*>(x), "drain expects optional positive integer token");
    return;
  }
  if (!x->state->engine) return;
  Record r;
  // Bounded control work, even if audio concurrently produces more frames.
  for (std::size_t n = 0; n < queueCapacity && x->state->engine->drain(r); ++n) {
    t_atom atoms[59];
    const std::uint64_t header[] = {
      2, r.epoch, r.generation, r.sequence, r.start, r.end,
      r.lost, r.partial, static_cast<std::uint64_t>(r.reason)
    };
    for (std::size_t i = 0; i < 9; ++i) atom_setlong(atoms + i, header[i]);
    atom_setfloat(atoms + 9, r.sampleRate);
    atom_setlong(atoms + 10, bands);
    for (std::size_t i = 0; i < bands; ++i) {
      atom_setfloat(atoms + 11 + i, r.left[i]);
      atom_setfloat(atoms + 35 + i, r.right[i]);
    }
    const char* name = r.kind == Kind::frame ? "mel_frame" :
                       r.kind == Kind::started ? "mel_started" :
                       r.kind == Kind::ready ? "mel_ready" : "mel_stopped";
    outlet_anything(x->outlet, gensym(name), r.kind == Kind::frame ? 59 : 11, atoms);
  }
  const auto status = x->state->engine->drainReceipt();
  const std::uint64_t fields[] = {
    2, token, status.epoch, status.generation, status.records, status.frames,
    status.terminal ? 1ULL : 0ULL, status.clockValid ? 1ULL : 0ULL,
    status.clockExclusive
  };
  t_atom receipt[9];
  for (std::size_t i = 0; i < 9; ++i) atom_setlong(receipt + i, fields[i]);
  outlet_anything(x->outlet, gensym("mel_drain"), 9, receipt);
}
void arm(External* x, t_symbol* s, long argc, t_atom* argv) {
  defer_low(x, reinterpret_cast<method>(armLow), s, argc, argv);
}
void stop(External* x, t_symbol* s, long argc, t_atom* argv) {
  defer_low(x, reinterpret_cast<method>(stopLow), s, argc, argv);
}
void drain(External* x, t_symbol* s, long argc, t_atom* argv) {
  defer_low(x, reinterpret_cast<method>(drainLow), s, argc, argv);
}
void perform(External* x, t_object*, double** ins, long, double**, long,
             long size, long, void*) {
  if (x->state->engine)
    x->state->engine->process(
      {ins[0], ins[1], ins[2], ins[3], ins[4],
       ins[5], ins[6], ins[7], ins[8], ins[9]}, size);
}
void dsp64(External* x, t_object* chain, short* count, double rate, long, long) {
  try {
    if (!x->state->engine) x->state->engine = std::make_unique<Engine>(rate);
    bool connected = true;
    for (int i = 0; i < 10; ++i) connected = connected && count[i];
    x->state->engine->dspSetup(rate, connected);
    object_method(chain, gensym("dsp_add64"), x, perform, 0, nullptr);
  } catch (const std::exception& e) {
    object_error(reinterpret_cast<t_object*>(x), "DSP setup failed: %s", e.what());
  }
}
void destroy(External* x) {
  dsp_free(&x->object);
  delete x->state;
}
void* create() {
  auto* x = reinterpret_cast<External*>(object_alloc(klass));
  if (!x) return nullptr;
  x->state = nullptr;
  dsp_setup(&x->object, 10);
  try { x->state = new State; }
  catch (...) { object_free(x); return nullptr; }
  x->object.z_misc |= Z_NO_INPLACE;
  x->outlet = outlet_new(x, nullptr);
  return x;
}
} // namespace

extern "C" C74_EXPORT void ext_main(void*) {
  klass = class_new("listener.mel~", reinterpret_cast<method>(create),
                    reinterpret_cast<method>(destroy), sizeof(External), nullptr, 0);
  class_addmethod(klass, reinterpret_cast<method>(dsp64), "dsp64", A_CANT, 0);
  class_addmethod(klass, reinterpret_cast<method>(arm), "arm", A_GIMME, 0);
  class_addmethod(klass, reinterpret_cast<method>(stop), "stop", A_GIMME, 0);
  class_addmethod(klass, reinterpret_cast<method>(drain), "drain", A_GIMME, 0);
  class_dspinit(klass);
  class_register(CLASS_BOX, klass);
}
