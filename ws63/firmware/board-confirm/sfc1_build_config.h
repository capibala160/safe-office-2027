#ifndef SFC1_BUILD_CONFIG_H
#define SFC1_BUILD_CONFIG_H

/*
 * 构建变体开关（ws63/firmware/build-m3.cjs 生成/覆盖）
 *
 * 仓库里的这份是默认 M3 固件：不带 SLE 链路，行为与 docs/72 完全一致。
 * 构建 M2 双板链路时：
 *   node ws63/firmware/build-m3.cjs --link --role=confirm --build
 *   node ws63/firmware/build-m3.cjs --link --role=exec --build
 */

#define SFC1_WITH_LINK 0
#define SFC1_LINK_ROLE 1 /* 0=exec/client，1=confirm/server；仅 SFC1_WITH_LINK=1 时生效 */

#endif /* SFC1_BUILD_CONFIG_H */
