// Loop order in matrix multiply: C += A * B with ijk, ikj or jki loop nests.
// args: 32 ijk
// cache: 5 1 5
//
// args "N ORDER": N x N doubles, ORDER in {ijk, ikj, jki} (the three classes from CS:APP 6.6).
//   ijk: inner loop walks a row of A (stride 1) and a column of B (stride N)  -> B misses a lot
//   ikj: inner loop walks rows of B and C (stride 1)                          -> fewest misses
//   jki: inner loop walks columns of A and C (stride N)                       -> most misses
// Same arithmetic, same result, very different cache behaviour.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "tarray.hpp"

int main(int argc, char** argv) {
    int n = argc > 1 ? std::atoi(argv[1]) : 32;
    const char* order = argc > 2 ? argv[2] : "ijk";

    dig::tmatrix<double> A(n, n, "A"), B(n, n, "B"), C(n, n, "C");
    {
        dig::Untraced quiet;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) {
                A(i, j) = (i + j) % 5;
                B(i, j) = (i * j) % 3;
                C(i, j) = 0;
            }
    }

    dig::mark(std::string("multiply ") + order);
    if (!std::strcmp(order, "ikj")) {
        for (int i = 0; i < n; i++)
            for (int k = 0; k < n; k++) {
                double r = A(i, k);
                for (int j = 0; j < n; j++) C(i, j) += r * B(k, j);
            }
    } else if (!std::strcmp(order, "jki")) {
        for (int j = 0; j < n; j++)
            for (int k = 0; k < n; k++) {
                double r = B(k, j);
                for (int i = 0; i < n; i++) C(i, j) += A(i, k) * r;
            }
    } else {  // ijk
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) {
                double sum = 0;
                for (int k = 0; k < n; k++) sum += A(i, k) * B(k, j);
                C(i, j) += sum;
            }
    }

    double check = 0;
    {
        dig::Untraced quiet;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) check += C(i, j);
    }
    std::printf("N=%d order=%s checksum=%.0f\n", n, order, check);
}
