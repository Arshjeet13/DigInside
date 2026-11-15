// Spatial locality: sum an array with a stride, several passes.
// args: 2048 1 2
// cache: 5 1 5
//
// args "N STRIDE PASSES": N ints (4 bytes each), visit every STRIDE-th one, repeat PASSES times.
//   stride 1  -> one miss per block, then hits on the rest of the block (B/4 ints per block)
//   stride >= B/4 -> every access lands in a new block: every access misses
//   pass 2+   -> hits if the visited blocks fit in the cache, capacity misses if they don't
// Try N=2048 (8 KB) against a 1 KB cache vs an 8 KB cache.
#include <cstdio>
#include <cstdlib>
#include "tarray.hpp"

int main(int argc, char** argv) {
    std::size_t n = argc > 1 ? std::strtoul(argv[1], nullptr, 10) : 2048;
    std::size_t stride = argc > 2 ? std::strtoul(argv[2], nullptr, 10) : 1;
    int passes = argc > 3 ? std::atoi(argv[3]) : 2;
    if (stride == 0) stride = 1;

    dig::tarray<int> a(n, "a");
    {
        dig::Untraced quiet;  // initialization isn't part of the experiment
        for (std::size_t i = 0; i < n; i++) a[i] = int(i % 7);
    }
    long long sum = 0;
    for (int p = 0; p < passes; p++) {
        dig::mark("pass " + std::to_string(p + 1));
        for (std::size_t i = 0; i < n; i += stride) sum += a[i];
    }
    std::printf("n=%zu stride=%zu passes=%d sum=%lld\n", n, stride, passes, sum);
}
