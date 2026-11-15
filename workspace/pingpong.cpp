// Two threads hand a token back and forth through a mutex + condition variable.
// Every hand-off blocks one thread and wakes the other: lots of *voluntary* context switches
// and futex() syscalls. Pin it to ONE core vs TWO cores and compare how fast it goes.
// (Spoiler: one core is often much faster. Waking a thread that sleeps on *another* core
//  needs an inter-processor interrupt and a cache-line transfer; on one core it's a quick switch.)
//   args "200000"  -> number of round trips
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <thread>

int main(int argc, char** argv) {
    long rounds = argc > 1 ? atol(argv[1]) : 200000;
    std::mutex m;
    std::condition_variable cv;
    int turn = 0;
    auto player = [&](int me) {
        for (long i = 0; i < rounds; i++) {
            std::unique_lock lk(m);
            cv.wait(lk, [&] { return turn == me; });
            turn = 1 - me;
            cv.notify_one();
        }
    };
    auto t0 = std::chrono::steady_clock::now();
    std::thread a(player, 0), b(player, 1);
    a.join();
    b.join();
    double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    printf("%ld round trips in %.3f s (%.2f us each)\n", rounds, s, s * 1e6 / rounds);
}
