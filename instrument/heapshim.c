// heapshim.c — LD_PRELOAD helper for DigInside's Valgrind tracer.
// Logs every malloc/calloc/realloc result ("alloc <hexaddr> <bytes> <hex caller>") to $DIGINSIDE_HEAPLOG so heap
// blocks touched by the program can be labeled in the cache view. new/std::vector go through malloc.
// It calls glibc's __libc_* entry points directly, so it never recurses into itself.
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t, size_t);
extern void *__libc_realloc(void *, size_t);

static int fd = -2;
static __thread int busy;

static void logit(void *p, size_t n, void *caller) {
    if (busy || !p) return;
    busy = 1;
    if (fd == -2) {
        const char *f = getenv("DIGINSIDE_HEAPLOG");
        fd = f ? open(f, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644) : -1;
    }
    if (fd >= 0) {
        char buf[96];
        int k = snprintf(buf, sizeof buf, "alloc %lx %zu %lx\n", (unsigned long)p, n, (unsigned long)caller);
        if (k > 0) (void)!write(fd, buf, (size_t)k);
    }
    busy = 0;
}

void *malloc(size_t n) { void *p = __libc_malloc(n); logit(p, n, __builtin_return_address(0)); return p; }
void *calloc(size_t a, size_t b) { void *p = __libc_calloc(a, b); logit(p, a * b, __builtin_return_address(0)); return p; }
void *realloc(void *q, size_t n) { void *p = __libc_realloc(q, n); logit(p, n, __builtin_return_address(0)); return p; }
