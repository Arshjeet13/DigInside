// Three arrays of 16 ints — a global, a local (stack) and a malloc'd (heap) one — written, then summed.
// args:
// cache: 2 1 4
//
// Plain C, no tarray.hpp: a Cache module traces it with Valgrind (Trace: Auto), so you see the real
// loads and stores of the compiled code, each tagged with the source line that made it.
//
// Try it on a tiny cache (4 sets x 1 line x 16-byte blocks = 64 bytes):
//   - one 16-byte block holds 4 ints, so g[0] misses and g[1..3] hit (spatial locality)
//   - g, local and h live far apart in memory (globals, stack, heap) but still map onto the same
//     4 sets, so they keep evicting each other (conflict misses)
//   - open the program's build command and switch -O2 <-> -O0: at -O0 the loop counter i and the sum s
//     live on the stack, so you'll see a load of i on every line; at -O2 they stay in registers and the
//     compiler writes 4 ints at once (16-byte SIMD stores)
#include <stdio.h>
#include <stdlib.h>

int g[16];

int main(void) {
    int local[16];
    int *h = malloc(16 * sizeof(int));
    for (int i = 0; i < 16; i++) {
        g[i] = i;
        local[i] = 2 * i;
        h[i] = 3 * i;
    }
    int s = 0;
    for (int i = 0; i < 16; i++) s += g[i] + local[i] + h[i];
    printf("s = %d\n", s);
    free(h);
    return 0;
}
