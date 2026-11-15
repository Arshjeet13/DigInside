// Matrix transpose: naive vs blocked (tiled), with optional row padding.
// args: 64 naive 4 0
// cache: 5 1 5
//
// args "N MODE BLOCK PAD": N x N doubles, MODE in {naive, blocked}, BLOCK = tile size, PAD = extra
// doubles per row.
//   naive:   reads rows of src (stride 1) but writes columns of dst (stride N): each write touches a
//            new block, and with N a power of two those blocks pile into the same few sets
//            (conflict misses).
//   blocked: transposes BLOCK x BLOCK tiles so both the src and dst tiles stay in the cache.
//   PAD > 0: rows no longer start at power-of-two offsets, spreading columns across sets.
//            Use a whole block (PAD 4 = 32 bytes with 32-byte blocks) so rows stay block-aligned.
//
// On the suggested 1 KB direct-mapped cache (s=5 E=1 b=5), N=64 (measured miss rates):
//   naive        pad 0: 63.7%      naive        pad 4: 64.0%   (still capacity-bound)
//   blocked 4    pad 0: 63.7%      blocked 4    pad 4: 29.2%   (src and dst tiles no longer collide)
// Blocking alone doesn't help here: src and dst rows map to the same sets, so the tiles evict each
// other (watch the conflict count). Padding removes the conflicts and blocking then pays off.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "tarray.hpp"

int main(int argc, char** argv) {
    int n = argc > 1 ? std::atoi(argv[1]) : 64;
    const char* mode = argc > 2 ? argv[2] : "naive";
    int bs = argc > 3 ? std::atoi(argv[3]) : 4;
    int pad = argc > 4 ? std::atoi(argv[4]) : 0;
    if (bs < 1) bs = 1;

    dig::tmatrix<double> src(n, n, "src", n + pad), dst(n, n, "dst", n + pad);
    {
        dig::Untraced quiet;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) src(i, j) = i * n + j;
    }

    if (!std::strcmp(mode, "blocked")) {
        dig::mark("blocked transpose, tile " + std::to_string(bs));
        for (int ii = 0; ii < n; ii += bs)
            for (int jj = 0; jj < n; jj += bs)
                for (int i = ii; i < ii + bs && i < n; i++)
                    for (int j = jj; j < jj + bs && j < n; j++) dst(j, i) = src(i, j);
    } else {
        dig::mark("naive transpose");
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) dst(j, i) = src(i, j);
    }

    bool ok = true;
    {
        dig::Untraced quiet;
        for (int i = 0; i < n && ok; i++)
            for (int j = 0; j < n; j++)
                if (double(dst(j, i)) != double(src(i, j))) { ok = false; break; }
    }
    std::printf("N=%d mode=%s block=%d pad=%d %s\n", n, mode, bs, pad, ok ? "correct" : "WRONG");
}
