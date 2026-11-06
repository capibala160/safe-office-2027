/*
 * eFuse 客户预留区只读探测（docs/60 阶段 B，2026-11-06）
 *
 * 安全约束：本模块只调用读接口，源码中不得出现任何 efuse write API。
 * 地址：客户预留区起点 = 第 222 字节（bit 1776），长度 16 字节。
 */
#ifndef EFUSE_PROBE_H
#define EFUSE_PROBE_H

#include <stdint.h>

#define EFUSE_PROBE_USER_ABS_OFFSET 222u
#define EFUSE_PROBE_USER_LEN        16u

/* 只读：读取客户预留区 16B，打印用户区读与绝对地址读的对照结果。 */
void efuse_probe_report(void);

#endif
