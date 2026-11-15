"""Python threads vs the GIL.

Run with args "4": four threads each run a pure-Python loop. On the canvas they land on
different cores, but each gets only ~1/N of the time — together they use about ONE core,
because only the thread holding the Global Interpreter Lock can run Python bytecode.
Compare with threads.cpp ("4 3 spin"), whose threads really run in parallel.
"""
import sys
import threading
import time

n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
work = int(sys.argv[2]) if len(sys.argv) > 2 else 150_000_000


def spin(i: int):
    t0 = time.time()
    x = 0
    for k in range(work // n):
        x += k
    print(f"thread {i} done in {time.time() - t0:.2f}s")


print(f"{n} threads, {work:,} loop iterations total")
ts = [threading.Thread(target=spin, args=(i,)) for i in range(n)]
for t in ts:
    t.start()
for t in ts:
    t.join()
