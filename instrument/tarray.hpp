// tarray.hpp — traced arrays for DigInside Cache mode.
//
// Only accesses through these types are logged, so the trace shows exactly the memory traffic of
// your algorithm (no library or stack noise). Each element read/write appends a line to the file
// named by $DIGINSIDE_TRACE:
//
//     R <hexaddr> <size>      read  of <size> bytes at <hexaddr>
//     W <hexaddr> <size>      write of <size> bytes at <hexaddr>
//     # alloc <name> <hexbase> <bytes> <elemsize>   an array was created (lets the UI color by array)
//     # mark <label>          a phase marker from dig::mark()
//     # truncated ...         the access limit ($DIGINSIDE_MAX_ACCESSES) was reached
//
// Addresses come from a *simulated* address space: arrays are placed one after another starting at
// 0x10000000, each aligned to 64 bytes (or the alignment you pass). This makes traces identical on
// every run (no ASLR/malloc randomness) while keeping realistic layout effects: the relative
// placement of arrays decides which cache sets they share.
//
// Usage:
//     #include "tarray.hpp"
//     dig::tarray<int> a(1024, "a");          // 1024 ints named "a"
//     dig::tmatrix<double> m(64, 64, "M");    // 64x64 row-major matrix
//     a[i] = a[i - 1] + 1;                    // logs R a[i-1], then W a[i]
//     a[i] += 2;                              // logs R then W (load-op-store)
//     m(i, j) = m(j, i);                      // logs R m(j,i), then W m(i,j)
//     { dig::Untraced quiet; /* init */ }    // accesses inside this scope are not logged
//     dig::mark("phase 2");                   // shows up on the Cache mode timeline
//
// Single-threaded: the logger is not synchronized.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace dig {

class Tracer {
 public:
  static Tracer& get() {
    static Tracer t;
    return t;
  }

  void access(char op, std::uintptr_t addr, unsigned size) {
    if (!f_ || paused_ > 0) return;
    if (count_ >= max_) {
      if (!truncated_) {
        std::fprintf(f_, "# truncated after %llu accesses\n", static_cast<unsigned long long>(count_));
        truncated_ = true;
      }
      return;
    }
    std::fprintf(f_, "%c %llx %u\n", op, static_cast<unsigned long long>(addr), size);
    ++count_;
  }

  void mark(const std::string& label) {
    if (f_) std::fprintf(f_, "# mark %s\n", label.c_str());
  }

  std::uintptr_t alloc(const std::string& name, std::size_t bytes, std::size_t elem, std::size_t align) {
    if (align == 0 || (align & (align - 1)) != 0) align = 64;
    next_ = (next_ + align - 1) & ~static_cast<std::uintptr_t>(align - 1);
    std::uintptr_t base = next_;
    next_ += bytes;
    if (f_) {
      std::string n = name.empty() ? "array" + std::to_string(arrays_) : name;
      for (char& c : n)
        if (c == ' ') c = '_';
      std::fprintf(f_, "# alloc %s %llx %zu %zu\n", n.c_str(), static_cast<unsigned long long>(base), bytes, elem);
    }
    ++arrays_;
    return base;
  }

  void pause() { ++paused_; }
  void resume() {
    if (paused_ > 0) --paused_;
  }
  unsigned long long count() const { return count_; }

  Tracer(const Tracer&) = delete;
  Tracer& operator=(const Tracer&) = delete;

 private:
  Tracer() {
    if (const char* p = std::getenv("DIGINSIDE_TRACE")) {
      f_ = std::fopen(p, "w");
      if (f_) std::setvbuf(f_, nullptr, _IOFBF, 1 << 20);
    }
    if (const char* m = std::getenv("DIGINSIDE_MAX_ACCESSES")) max_ = std::strtoull(m, nullptr, 10);
  }
  ~Tracer() {
    if (f_) std::fclose(f_);
  }

  std::FILE* f_ = nullptr;
  unsigned long long count_ = 0;
  unsigned long long max_ = 1000000;
  bool truncated_ = false;
  int paused_ = 0;
  unsigned arrays_ = 0;
  std::uintptr_t next_ = 0x10000000;
};

inline void mark(const std::string& label) { Tracer::get().mark(label); }

/// Accesses made while an Untraced object is alive are not logged (e.g. initialization).
struct Untraced {
  Untraced() { Tracer::get().pause(); }
  ~Untraced() { Tracer::get().resume(); }
  Untraced(const Untraced&) = delete;
  Untraced& operator=(const Untraced&) = delete;
};

template <class T>
class tarray {
 public:
  explicit tarray(std::size_t n, const std::string& name = "", std::size_t align = 64)
      : v_(n), base_(Tracer::get().alloc(name, n * sizeof(T), sizeof(T), align)) {}
  tarray(std::size_t n, const T& init, const std::string& name, std::size_t align = 64)
      : v_(n, init), base_(Tracer::get().alloc(name, n * sizeof(T), sizeof(T), align)) {}

  /// Proxy for one element: converting it to T logs a read, assigning to it logs a write.
  class ref {
   public:
    ref(tarray& a, std::size_t i) : a_(a), i_(i) {}
    operator T() const {
      a_.log('R', i_);
      return a_.v_[i_];
    }
    ref& operator=(const T& x) {
      a_.log('W', i_);
      a_.v_[i_] = x;
      return *this;
    }
    ref& operator=(const ref& o) { return *this = static_cast<T>(o); }  // a[i] = b[j]: R b[j], W a[i]
    ref& operator+=(const T& x) { return *this = static_cast<T>(*this) + x; }
    ref& operator-=(const T& x) { return *this = static_cast<T>(*this) - x; }
    ref& operator*=(const T& x) { return *this = static_cast<T>(*this) * x; }
    ref& operator/=(const T& x) { return *this = static_cast<T>(*this) / x; }
    ref& operator++() { return *this += T(1); }
    ref& operator--() { return *this -= T(1); }
    T operator++(int) {
      T old = *this;
      *this = old + T(1);
      return old;
    }
    T operator--(int) {
      T old = *this;
      *this = old - T(1);
      return old;
    }

   private:
    tarray& a_;
    std::size_t i_;
  };

  ref operator[](std::size_t i) {
    check(i);
    return ref(*this, i);
  }
  T operator[](std::size_t i) const {
    check(i);
    log('R', i);
    return v_[i];
  }

  std::size_t size() const { return v_.size(); }
  std::uintptr_t address(std::size_t i) const { return base_ + i * sizeof(T); }
  /// Raw storage, bypassing the tracer (handy for checking results).
  T* untraced_data() { return v_.data(); }

 private:
  void check(std::size_t i) const {
    if (i >= v_.size()) {
      std::fprintf(stderr, "tarray: index %zu out of bounds (size %zu)\n", i, v_.size());
      std::abort();
    }
  }
  void log(char op, std::size_t i) const { Tracer::get().access(op, base_ + i * sizeof(T), sizeof(T)); }

  std::vector<T> v_;
  std::uintptr_t base_;
};

/// Row-major matrix on top of tarray. `ld` (leading dimension) is the row pitch in elements;
/// pass ld > cols to pad rows, which changes how rows map onto cache sets.
template <class T>
class tmatrix {
 public:
  tmatrix(std::size_t rows, std::size_t cols, const std::string& name = "", std::size_t ld = 0, std::size_t align = 64)
      : rows_(rows), cols_(cols), ld_(ld ? ld : cols), a_(rows * (ld ? ld : cols), name, align) {}

  typename tarray<T>::ref operator()(std::size_t i, std::size_t j) {
    check(i, j);
    return a_[i * ld_ + j];
  }
  std::size_t rows() const { return rows_; }
  std::size_t cols() const { return cols_; }
  std::size_t ld() const { return ld_; }

 private:
  void check(std::size_t i, std::size_t j) const {
    if (i >= rows_ || j >= cols_) {
      std::fprintf(stderr, "tmatrix: index (%zu, %zu) out of bounds (%zu x %zu)\n", i, j, rows_, cols_);
      std::abort();
    }
  }
  std::size_t rows_, cols_, ld_;
  tarray<T> a_;
};

}  // namespace dig
