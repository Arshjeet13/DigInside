// Multithreaded matrix multiplication: C = A * B, all N x N doubles.
//
//   args "N THREADS"    e.g. "2000 1", "2000 4", "2000 8", "2000 16", "2000 32"
//
// The work is N^3 multiply-adds no matter how many threads share it. THREADS threads each take
// a contiguous band of rows of C, so with P threads the run takes about N^3 / P time:
// a constant-factor speedup, capped by how many cores can run at once (16 vCPUs here),
// not a change in complexity. Going past the core count just makes threads take turns.
//
// Try: run "2000 1" then "2000 8" and compare the printed time and the canvas (1 hot core vs 8).
// Pin the 8-thread run to 2 CPUs and watch 8 threads crowd onto 2 cores at ~25% each.
//
// Loop order is i-k-j: the inner loop walks rows of B and C contiguously, so it is cache-friendly
// and the compiler can vectorize it (Cache mode shows why the textbook i-j-k order is slower).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <thread>
#include <vector>

int main(int argc, char** argv) {
    const int n = argc > 1 ? atoi(argv[1]) : 2000;
    int p = argc > 2 ? atoi(argv[2]) : 8;
    if (n <= 0) { fprintf(stderr, "N must be positive\n"); return 1; }
    if (p < 1) p = 1;
    if (p > n) p = n;  // at least one row per thread

    std::vector<double> A(size_t(n) * n), B(size_t(n) * n), C(size_t(n) * n, 0.0);
    std::mt19937_64 rng(42);
    std::uniform_real_distribution<double> d(-1.0, 1.0);
    for (auto& x : A) x = d(rng);
    for (auto& x : B) x = d(rng);
    printf("C = A * B with N = %d (%.2f G multiply-adds), %d thread%s\n", n, double(n) * n * n / 1e9, p, p == 1 ? "" : "s");

    // Thread t computes rows [lo, hi) of C.
    auto band = [&](int lo, int hi) {
        for (int i = lo; i < hi; i++) {
            double* c = &C[size_t(i) * n];
            for (int k = 0; k < n; k++) {
                const double a = A[size_t(i) * n + k];
                const double* b = &B[size_t(k) * n];
                for (int j = 0; j < n; j++) c[j] += a * b[j];
            }
        }
    };

    auto t0 = std::chrono::steady_clock::now();
    std::vector<std::thread> ts;
    for (int t = 0; t < p; t++) {
        int lo = int(int64_t(n) * t / p), hi = int(int64_t(n) * (t + 1) / p);
        ts.emplace_back(band, lo, hi);
    }
    for (auto& t : ts) t.join();
    double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    // Spot-check a few entries against a direct dot product.
    double maxerr = 0;
    std::mt19937 pick(7);
    for (int r = 0; r < 16; r++) {
        int i = pick() % n, j = pick() % n;
        double ref = 0;
        for (int k = 0; k < n; k++) ref += A[size_t(i) * n + k] * B[size_t(k) * n + j];
        maxerr = std::fmax(maxerr, std::fabs(ref - C[size_t(i) * n + j]));
    }
    printf("time %.3f s, %.2f GFLOP/s, spot-check max error %.2e %s\n",
           s, 2.0 * n * n * n / s / 1e9, maxerr, maxerr < 1e-9 ? "(correct)" : "(WRONG)");
}
