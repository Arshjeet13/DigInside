// The cost of crossing into the kernel.
//   args "64 3"       -> for 3 seconds, write() 64-byte chunks      (millions of syscalls: kernel time dominates)
//   args "1048576 3"  -> for 3 seconds, write() 1 MB chunks         (a few thousand syscalls, mostly copying data)
// Compare the throughput it prints, the user/kernel bar, and the syscall counter.
// Then turn strace on: every syscall now also stops the program twice for the tracer,
// so the 64-byte version slows down enormously while the 1 MB version barely notices.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>
#include <vector>

int main(int argc, char** argv) {
    size_t chunk = argc > 1 ? strtoul(argv[1], nullptr, 10) : 64;
    double seconds = argc > 2 ? atof(argv[2]) : 3.0;
    if (chunk == 0) chunk = 64;
    std::vector<char> buf(chunk, 'x');
    char path[] = "/dev/shm/diginside-syscalls-XXXXXX";  // RAM-backed file: no disk involved
    int fd = mkstemp(path);
    if (fd < 0) { perror("mkstemp"); return 1; }
    unlink(path);

    const size_t wrap = 64u << 20;  // rewind every 64 MB so the file stays small
    size_t calls = 0, bytes = 0, pos = 0;
    auto t0 = std::chrono::steady_clock::now();
    auto end = t0 + std::chrono::duration<double>(seconds);
    while (std::chrono::steady_clock::now() < end) {
        for (int i = 0; i < 64; i++) {
            if (write(fd, buf.data(), chunk) < 0) { perror("write"); return 1; }
            calls++, bytes += chunk, pos += chunk;
            if (pos >= wrap) { lseek(fd, 0, SEEK_SET); pos = 0; }
        }
    }
    double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    printf("%zu write() calls of %zu bytes in %.2f s\n", calls, chunk, s);
    printf("throughput %.1f MB/s, %.2f us per call\n", bytes / s / 1e6, s * 1e6 / calls);
    close(fd);
}
