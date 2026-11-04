set(SOURCES_LIST
    ${CMAKE_CURRENT_SOURCE_DIR}/hal_bsp_oled/hal_bsp_ssd1306.c
    ${CMAKE_CURRENT_SOURCE_DIR}/board_confirm_m3.c
    ${CMAKE_CURRENT_SOURCE_DIR}/protocol.c
    ${CMAKE_CURRENT_SOURCE_DIR}/sfc1_hmac.c
    ${CMAKE_CURRENT_SOURCE_DIR}/sfc1_nv.c
    ${CMAKE_CURRENT_SOURCE_DIR}/sfc1_key_store.c
    ${CMAKE_CURRENT_SOURCE_DIR}/sfc1_provision.c
)
set(HEADER_LIST
    ${CMAKE_CURRENT_SOURCE_DIR}/hal_bsp_oled
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../open_source/mbedtls/mbedtls_v3.6.0/include
)

set(SOURCES "${SOURCES}" ${SOURCES_LIST} PARENT_SCOPE)
set(PUBLIC_HEADER "${PUBLIC_HEADER}" ${HEADER_LIST} PARENT_SCOPE)
