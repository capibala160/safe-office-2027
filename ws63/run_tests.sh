#!/bin/sh
# PC 侧协议测试（Git Bash / MSYS2）
set -eu
cd "$(dirname "$0")"
gcc -std=c11 -Wall -Wextra -Werror -O2 -o test_protocol protocol.c test_protocol.c
./test_protocol
