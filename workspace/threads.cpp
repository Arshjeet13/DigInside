// System-mode demo.
//   threads N SECS                  N workers alternate CPU bursts with 100ms sleeps,
//                                   plus one I/O thread making lots of small write() syscalls
//   threads N SECS spin             N workers spin flat out (no sleeps, no I/O thread):
//                                   N threads should occupy ~N cores the whole time
//   (DigInside compiles it for you: drag it onto the canvas, set args, press Run)
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace std::chrono;

static volatile double sink;

static bool spin = false;

static void worker(int id, double seconds) {
    if (spin) {
        auto end = steady_clock::now() + duration<double>(seconds);
        double x = id;
        while (steady_clock::now() < end) x = x * 1.0000001 + 1e-9;
        sink = x;
        return;
    }
    auto end = steady_clock::now() + duration<double>(seconds);
    while (steady_clock::now() < end) {
        auto burst = steady_clock::now() + milliseconds(200 + 50 * id);  // user time
        double x = id;
        while (steady_clock::now() < burst) x = x * 1.0000001 + 1e-9;
        sink = x;
        std::this_thread::sleep_for(milliseconds(100));                  // voluntary switch
    }
}

static void io_thread(double seconds) {
    int fd = open("/dev/null", O_WRONLY);
    char buf[64] = {0};
    auto end = steady_clock::now() + duration<double>(seconds);
    while (steady_clock::now() < end) {
        for (int i = 0; i < 200; i++)                                   // kernel time
            if (write(fd, buf, sizeof buf) < 0) break;
        std::this_thread::sleep_for(milliseconds(20));
    }
    close(fd);
}

int main(int argc, char** argv) {
    int n = argc > 1 ? atoi(argv[1]) : 4;
    double secs = argc > 2 ? atof(argv[2]) : 3.0;
    spin = argc > 3 && std::string(argv[3]) == "spin";
    if (spin) printf("starting %d spinning workers for %.1fs\n", n, secs);
    else printf("starting %d bursty workers + 1 io thread for %.1fs\n", n, secs);
    std::vector<std::thread> ts;
    for (int i = 0; i < n; i++) ts.emplace_back(worker, i, secs);
    if (!spin) ts.emplace_back(io_thread, secs);
    for (auto& t : ts) t.join();
    printf("done\n");
}
