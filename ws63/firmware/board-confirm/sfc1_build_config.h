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
#define SFC1_DEVICE_LABEL "ws63-A" /* 单板默认；M2/M3' 双板变体由脚本按角色生成 */
#define SFC1_WITH_WIFI 0 /* 1=同时开 WiFi STA 并周期扫描（共存观测，不连 AP/不传数据） */

#endif /* SFC1_BUILD_CONFIG_H */
