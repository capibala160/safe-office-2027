/*
 * SFC1 SLE 传输适配器（M2）
 *
 * 基于 SDK 样例 src/application/samples/bt/sle/sle_uart 的 server/client 流程裁剪：
 *   - 去掉 UART 透传，收发直接交给上层回调
 *   - 扫描按广播名匹配（有界匹配，不依赖 NUL 结尾）
 *   - server 在 SLE 连接建立后报告；client 等服务发现拿到写句柄后才报告，
 *     避免上层在发送路径未就绪时提前发心跳
 *
 * 编译开关：sfc1_build_config.h 的 SFC1_WITH_LINK；关闭时本文件为空编译单元。
 */

#include "sfc1_build_config.h"

#if SFC1_WITH_LINK

#include "sle_link.h"

#include "common_def.h"
#include "errcode.h"
#include "securec.h"
#include "soc_osal.h"
#include "string.h"

#include "sle_common.h"
#include "sle_connection_manager.h"
#include "sle_device_discovery.h"
#include "sle_errcode.h"
#include "sle_ssap_server.h"
#include "sle_ssap_client.h"

/* 广播数据类型在厂商样例里是各样例自带的私有定义（SDK 公共头没有），这里按
 * sle_uart_server_adv.h 原样收一份，避免依赖样例目录。 */
struct sle_adv_common_value {
    uint8_t length;
    uint8_t type;
    uint8_t value;
};

typedef enum {
    SLE_ADV_DATA_TYPE_DISCOVERY_LEVEL = 0x01,
    SLE_ADV_DATA_TYPE_ACCESS_MODE = 0x02,
    SLE_ADV_DATA_TYPE_COMPLETE_LOCAL_NAME = 0x0B,
    SLE_ADV_DATA_TYPE_TX_POWER_LEVEL = 0x0C,
} sle_adv_data_type_t;

#define SLE_ADV_CHANNEL_MAP_DEFAULT 0x07u

#define SLE_LINK_LOG "[SFC1 SLE]"

#define SLE_ADV_HANDLE_DEFAULT 1u
#define SLE_ADV_DATA_LEN_MAX 251u
#define SLE_NAME_MAX 16u
#define SLE_UUID_LEN_2 2u
#define SLE_UUID_INDEX 14u

#define SLE_CONN_INTV 12u
#define SLE_ADV_INTERVAL 0xC8u
#define SLE_CONN_SUPERVISION_TIMEOUT 0x1F4u
#define SLE_CONN_MAX_LATENCY 0x1F3u
#define SLE_ANNOUNCE_TX_POWER_DBM 18
#define SLE_ADV_TX_POWER 10
#define SLE_SEEK_INTERVAL_DEFAULT 100u
#define SLE_SEEK_WINDOW_DEFAULT 100u
#define SLE_CORE_READY_WAIT_MS 5000u

#define SFC1_SLE_SERVICE_UUID 0x2222u
#define SFC1_SLE_PROPERTY_UUID 0x2323u
#define SFC1_SLE_PROPERTIES (SSAP_PERMISSION_READ | SSAP_PERMISSION_WRITE)
#define SFC1_SLE_OPERATION \
    (SSAP_OPERATE_INDICATION_BIT_READ | SSAP_OPERATE_INDICATION_BIT_WRITE | SSAP_OPERATE_INDICATION_BIT_NOTIFY)
#define SFC1_SLE_DESCRIPTOR SSAP_PERMISSION_READ

/* 演示固定本地地址（本地管理位=1）。本板启动日志一直有 init_sle_mac failed!，
 * NV/eFuse 没有工厂 SLE MAC；照厂商 sle_speed 样例的做法显式设置本地地址，
 * 否则 get_dev_addr(IFTYPE_SLE) 取不到地址，扫描/连接可能起不来。
 * 边界：这是演示地址，不冒充工厂 MAC，也不作为身份凭据。 */
static const uint8_t SFC1_SLE_LOCAL_ADDR_EXEC[SLE_ADDR_LEN] = { 0x02, 0x53, 0x46, 0x43, 0x31, 0x01 };
static const uint8_t SFC1_SLE_LOCAL_ADDR_CONFIRM[SLE_ADDR_LEN] = { 0x02, 0x53, 0x46, 0x43, 0x31, 0x02 };

typedef enum {
    SLE_LINK_MODE_NONE = 0,
    SLE_LINK_MODE_SERVER = 1,
    SLE_LINK_MODE_CLIENT = 2
} sle_link_mode_t;

static sle_link_mode_t g_mode = SLE_LINK_MODE_NONE;
static sle_link_rx_cb g_rx_cb = NULL;
static sle_link_state_cb g_state_cb = NULL;
static char g_name[SLE_NAME_MAX];

static uint16_t g_conn_id = 0;
static uint8_t g_connected = 0;
static uint8_t g_tx_buf[SFC1_SLE_MTU];

/* ---------------- server state ---------------- */
static uint8_t g_server_id = 0;
static uint16_t g_service_handle = 0;
static uint16_t g_property_handle = 0;
static const uint8_t g_app_uuid[2] = { 0x12, 0x34 };
static const uint8_t g_base_uuid[16] = { 0x37, 0xBE, 0xA8, 0x80, 0xFC, 0x70, 0x11, 0xEA,
                                         0xB7, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };

/* ---------------- client state ---------------- */
static ssapc_write_param_t g_write_param;
static ssapc_find_service_result_t g_find_service_result;
static sle_announce_seek_callbacks_t g_seek_cbk;
static sle_connection_callbacks_t g_connect_cbk;
static ssapc_callbacks_t g_ssapc_cbk;
static sle_addr_t g_remote_addr;
static uint8_t g_write_ready = 0;

static void sle_link_report_state(uint8_t connected)
{
    if (g_state_cb != NULL) {
        g_state_cb(connected);
    }
}

static void copy_name(const char *name)
{
    size_t len;
    (void)memset_s(g_name, sizeof(g_name), 0, sizeof(g_name));
    if (name == NULL) {
        return;
    }
    len = strlen(name);
    if (len >= sizeof(g_name)) {
        len = sizeof(g_name) - 1u;
    }
    (void)memcpy_s(g_name, sizeof(g_name), name, len);
}

static void set_local_addr(const uint8_t addr[SLE_ADDR_LEN])
{
    sle_addr_t local;

    (void)memset_s(&local, sizeof(local), 0, sizeof(local));
    local.type = 0;
    if (memcpy_s(local.addr, SLE_ADDR_LEN, addr, SLE_ADDR_LEN) != EOK) {
        return;
    }
    if (sle_set_local_addr(&local) != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s set local addr fail\r\n", SLE_LINK_LOG);
    } else {
        osal_printk("%s local addr %02x:%02x:%02x:%02x:%02x:%02x\r\n", SLE_LINK_LOG, (unsigned)addr[0],
                    (unsigned)addr[1], (unsigned)addr[2], (unsigned)addr[3], (unsigned)addr[4], (unsigned)addr[5]);
    }
}

static int adv_name_matches(const uint8_t *data, uint8_t len)
{
    size_t name_len = strlen(g_name);
    uint16_t i;

    if (data == NULL || name_len == 0 || (size_t)len < name_len) {
        return 0;
    }
    for (i = 0; (size_t)i + name_len <= (size_t)len; i++) {
        if (memcmp(&data[i], g_name, name_len) == 0) {
            return 1;
        }
    }
    return 0;
}

static void uuid_encode16(uint8_t *ptr, uint16_t value)
{
    ptr[0] = (uint8_t)(value & 0xffu);
    ptr[1] = (uint8_t)((value >> 8) & 0xffu);
}

static void uuid_set_base(sle_uuid_t *out)
{
    if (memcpy_s(out->uuid, SLE_UUID_LEN, g_base_uuid, sizeof(g_base_uuid)) != EOK) {
        out->len = 0;
        return;
    }
    out->len = (uint8_t)SLE_UUID_LEN_2;
}

static void uuid_set16(uint16_t value, sle_uuid_t *out)
{
    uuid_set_base(out);
    out->len = (uint8_t)SLE_UUID_LEN_2;
    uuid_encode16(&out->uuid[SLE_UUID_INDEX], value);
}

/* ============================ server ============================ */

static uint16_t adv_local_name(uint8_t *adv_data, uint16_t max_len)
{
    uint8_t name_len = (uint8_t)strlen(g_name);
    uint16_t index = 0;

    adv_data[index++] = (uint8_t)(name_len + 1u);
    adv_data[index++] = SLE_ADV_DATA_TYPE_COMPLETE_LOCAL_NAME;
    if ((size_t)index + name_len > (size_t)max_len) {
        return 0;
    }
    if (memcpy_s(&adv_data[index], (size_t)max_len - index, g_name, name_len) != EOK) {
        return 0;
    }
    return (uint16_t)(index + name_len);
}

static uint16_t adv_data_build(uint8_t *adv_data)
{
    size_t len = sizeof(struct sle_adv_common_value);
    uint16_t idx = 0;
    struct sle_adv_common_value disc_level = {
        .length = (uint8_t)(len - 1u),
        .type = SLE_ADV_DATA_TYPE_DISCOVERY_LEVEL,
        .value = SLE_ANNOUNCE_LEVEL_NORMAL,
    };
    struct sle_adv_common_value access_mode = {
        .length = (uint8_t)(len - 1u),
        .type = SLE_ADV_DATA_TYPE_ACCESS_MODE,
        .value = 0,
    };

    if (memcpy_s(&adv_data[idx], SLE_ADV_DATA_LEN_MAX - idx, &disc_level, len) != EOK) {
        return 0;
    }
    idx += (uint16_t)len;
    if (memcpy_s(&adv_data[idx], SLE_ADV_DATA_LEN_MAX - idx, &access_mode, len) != EOK) {
        return 0;
    }
    idx += (uint16_t)len;
    return idx;
}

static uint16_t scan_rsp_data_build(uint8_t *scan_rsp_data)
{
    uint16_t idx = 0;
    size_t len = sizeof(struct sle_adv_common_value);
    struct sle_adv_common_value tx_power = {
        .length = (uint8_t)(len - 1u),
        .type = SLE_ADV_DATA_TYPE_TX_POWER_LEVEL,
        .value = SLE_ADV_TX_POWER,
    };

    if (memcpy_s(scan_rsp_data, SLE_ADV_DATA_LEN_MAX, &tx_power, len) != EOK) {
        return 0;
    }
    idx += (uint16_t)len;
    idx += adv_local_name(&scan_rsp_data[idx], (uint16_t)(SLE_ADV_DATA_LEN_MAX - idx));
    return idx;
}

static int announce_param_set(void)
{
    sle_announce_param_t param;

    (void)memset_s(&param, sizeof(param), 0, sizeof(param));
    param.announce_mode = SLE_ANNOUNCE_MODE_CONNECTABLE_SCANABLE;
    param.announce_handle = SLE_ADV_HANDLE_DEFAULT;
    param.announce_gt_role = SLE_ANNOUNCE_ROLE_T_CAN_NEGO;
    param.announce_level = SLE_ANNOUNCE_LEVEL_NORMAL;
    param.announce_channel_map = SLE_ADV_CHANNEL_MAP_DEFAULT;
    param.announce_interval_min = SLE_ADV_INTERVAL;
    param.announce_interval_max = SLE_ADV_INTERVAL;
    param.conn_interval_min = SLE_CONN_INTV;
    param.conn_interval_max = SLE_CONN_INTV;
    param.conn_max_latency = SLE_CONN_MAX_LATENCY;
    param.conn_supervision_timeout = SLE_CONN_SUPERVISION_TIMEOUT;
    param.announce_tx_power = SLE_ANNOUNCE_TX_POWER_DBM;
    param.own_addr.type = 0;
    if (memcpy_s(param.own_addr.addr, SLE_ADDR_LEN, SFC1_SLE_LOCAL_ADDR_CONFIRM,
                 sizeof(SFC1_SLE_LOCAL_ADDR_CONFIRM)) != EOK) {
        return -1;
    }
    return sle_set_announce_param(SLE_ADV_HANDLE_DEFAULT, &param) == ERRCODE_SLE_SUCCESS ? 0 : -1;
}

static int announce_data_set(void)
{
    sle_announce_data_t data;
    uint8_t announce_data[SLE_ADV_DATA_LEN_MAX] = { 0 };
    uint8_t scan_rsp_data[SLE_ADV_DATA_LEN_MAX] = { 0 };

    (void)memset_s(&data, sizeof(data), 0, sizeof(data));
    data.announce_data_len = (uint8_t)adv_data_build(announce_data);
    data.announce_data = announce_data;
    data.seek_rsp_data_len = (uint8_t)scan_rsp_data_build(scan_rsp_data);
    data.seek_rsp_data = scan_rsp_data;
    return sle_set_announce_data(SLE_ADV_HANDLE_DEFAULT, &data) == ERRCODE_SLE_SUCCESS ? 0 : -1;
}

static void server_announce_enable_cbk(uint32_t announce_id, errcode_t status)
{
    osal_printk("%s announce enable id=%u status=0x%x\r\n", SLE_LINK_LOG, (unsigned)announce_id, (unsigned)status);
}

static void server_announce_disable_cbk(uint32_t announce_id, errcode_t status)
{
    unused(status);
    osal_printk("%s announce disable id=%u\r\n", SLE_LINK_LOG, (unsigned)announce_id);
}

static void server_announce_terminal_cbk(uint32_t announce_id)
{
    osal_printk("%s announce terminal id=%u\r\n", SLE_LINK_LOG, (unsigned)announce_id);
}

static void server_sle_enable_cbk(errcode_t status)
{
    osal_printk("%s sle enable status=%d\r\n", SLE_LINK_LOG, (int)status);
    if (status == 0) {
        set_local_addr(SFC1_SLE_LOCAL_ADDR_CONFIRM);
    }
}

static void server_write_cbk(uint8_t server_id,
                             uint16_t conn_id,
                             ssaps_req_write_cb_t *write_cb_para,
                             errcode_t status)
{
    unused(server_id);
    unused(conn_id);
    if (status != ERRCODE_SLE_SUCCESS || write_cb_para == NULL || write_cb_para->value == NULL ||
        write_cb_para->length == 0) {
        return;
    }
    if (g_rx_cb != NULL) {
        g_rx_cb(write_cb_para->value, write_cb_para->length);
    }
}

static void server_read_cbk(uint8_t server_id,
                            uint16_t conn_id,
                            ssaps_req_read_cb_t *read_cb_para,
                            errcode_t status)
{
    unused(server_id);
    unused(conn_id);
    unused(read_cb_para);
    unused(status);
}

static void server_mtu_changed_cbk(uint8_t server_id,
                                   uint16_t conn_id,
                                   ssap_exchange_info_t *mtu_size,
                                   errcode_t status)
{
    unused(status);
    osal_printk("%s mtu changed server=%u conn=0x%x mtu=%u\r\n", SLE_LINK_LOG, (unsigned)server_id,
                (unsigned)conn_id, mtu_size == NULL ? 0u : (unsigned)mtu_size->mtu_size);
}

static void server_add_service_cbk(uint8_t server_id, sle_uuid_t *uuid, uint16_t handle, errcode_t status)
{
    unused(uuid);
    unused(status);
    unused(server_id);
    unused(handle);
}

static void server_add_property_cbk(uint8_t server_id,
                                    sle_uuid_t *uuid,
                                    uint16_t service_handle,
                                    uint16_t handle,
                                    errcode_t status)
{
    unused(uuid);
    unused(status);
    unused(server_id);
    unused(service_handle);
    unused(handle);
}

static void server_add_descriptor_cbk(uint8_t server_id,
                                      sle_uuid_t *uuid,
                                      uint16_t service_handle,
                                      uint16_t property_handle,
                                      errcode_t status)
{
    unused(uuid);
    unused(status);
    unused(server_id);
    unused(service_handle);
    unused(property_handle);
}

static void server_start_service_cbk(uint8_t server_id, uint16_t handle, errcode_t status)
{
    unused(server_id);
    unused(handle);
    unused(status);
}

static void server_delete_all_service_cbk(uint8_t server_id, errcode_t status)
{
    unused(server_id);
    unused(status);
}

static void server_connect_state_cbk(uint16_t conn_id,
                                     const sle_addr_t *addr,
                                     sle_acb_state_t conn_state,
                                     sle_pair_state_t pair_state,
                                     sle_disc_reason_t disc_reason)
{
    unused(addr);
    osal_printk("%s conn state=0x%x pair=0x%x reason=0x%x conn=0x%x\r\n", SLE_LINK_LOG,
                (unsigned)conn_state, (unsigned)pair_state, (unsigned)disc_reason, (unsigned)conn_id);

    if (conn_state == SLE_ACB_STATE_CONNECTED) {
        g_conn_id = conn_id;
        if (!g_connected) {
            g_connected = 1;
            sle_link_report_state(1);
        }
    } else if (conn_state == SLE_ACB_STATE_DISCONNECTED) {
        if (g_connected) {
            g_connected = 0;
            sle_link_report_state(0);
        }
        g_conn_id = 0;
        (void)sle_start_announce(SLE_ADV_HANDLE_DEFAULT);
    }
}

static void server_pair_complete_cbk(uint16_t conn_id, const sle_addr_t *addr, errcode_t status)
{
    ssap_exchange_info_t info;

    unused(addr);
    osal_printk("%s pair complete conn=0x%x status=0x%x\r\n", SLE_LINK_LOG, (unsigned)conn_id, (unsigned)status);
    if (status == ERRCODE_SLE_SUCCESS) {
        (void)memset_s(&info, sizeof(info), 0, sizeof(info));
        info.mtu_size = SFC1_SLE_MTU;
        info.version = 1;
        (void)ssaps_set_info(g_server_id, &info);
    }
}

static errcode_t server_register_callbacks(void)
{
    static ssaps_callbacks_t ssaps_cbk = {
        .add_service_cb = server_add_service_cbk,
        .add_property_cb = server_add_property_cbk,
        .add_descriptor_cb = server_add_descriptor_cbk,
        .start_service_cb = server_start_service_cbk,
        .delete_all_service_cb = server_delete_all_service_cbk,
        .mtu_changed_cb = server_mtu_changed_cbk,
        .read_request_cb = server_read_cbk,
        .write_request_cb = server_write_cbk,
    };
    static sle_connection_callbacks_t conn_cbks = {
        .connect_state_changed_cb = server_connect_state_cbk,
        .pair_complete_cb = server_pair_complete_cbk,
    };
    sle_announce_seek_callbacks_t seek_cbks;
    errcode_t ret;

    (void)memset_s(&seek_cbks, sizeof(seek_cbks), 0, sizeof(seek_cbks));
    seek_cbks.sle_enable_cb = server_sle_enable_cbk;
    seek_cbks.announce_enable_cb = server_announce_enable_cbk;
    seek_cbks.announce_disable_cb = server_announce_disable_cbk;
    seek_cbks.announce_terminal_cb = server_announce_terminal_cbk;
    ret = sle_announce_seek_register_callbacks(&seek_cbks);
    if (ret != ERRCODE_SLE_SUCCESS) {
        return ret;
    }
    ret = sle_connection_register_callbacks(&conn_cbks);
    if (ret != ERRCODE_SLE_SUCCESS) {
        return ret;
    }
    return ssaps_register_callbacks(&ssaps_cbk);
}

static errcode_t server_service_add(void)
{
    sle_uuid_t service_uuid;
    ssaps_property_info_t property;
    ssaps_desc_info_t descriptor;
    uint8_t ntf_value[2] = { 0x01, 0x00 };
    errcode_t ret;

    (void)memset_s(&service_uuid, sizeof(service_uuid), 0, sizeof(service_uuid));
    uuid_set16(SFC1_SLE_SERVICE_UUID, &service_uuid);
    ret = ssaps_add_service_sync(g_server_id, &service_uuid, 1, &g_service_handle);
    if (ret != ERRCODE_SLE_SUCCESS) {
        return ret;
    }

    (void)memset_s(&property, sizeof(property), 0, sizeof(property));
    property.permissions = SFC1_SLE_PROPERTIES;
    property.operate_indication = SFC1_SLE_OPERATION;
    uuid_set16(SFC1_SLE_PROPERTY_UUID, &property.uuid);
    property.value = (uint8_t *)osal_vmalloc(1);
    if (property.value == NULL) {
        return ERRCODE_SLE_FAIL;
    }
    property.value[0] = 0;
    property.value_len = 1;
    ret = ssaps_add_property_sync(g_server_id, g_service_handle, &property, &g_property_handle);
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_vfree(property.value);
        return ret;
    }

    (void)memset_s(&descriptor, sizeof(descriptor), 0, sizeof(descriptor));
    descriptor.permissions = SFC1_SLE_DESCRIPTOR;
    descriptor.type = SSAP_DESCRIPTOR_USER_DESCRIPTION;
    descriptor.operate_indication = SSAP_OPERATE_INDICATION_BIT_READ;
    descriptor.value = ntf_value;
    descriptor.value_len = sizeof(ntf_value);
    ret = ssaps_add_descriptor_sync(g_server_id, g_service_handle, g_property_handle, &descriptor);
    osal_vfree(property.value);
    return ret;
}

static int server_start(void)
{
    sle_uuid_t app_uuid;
    errcode_t ret;

    if (enable_sle() != ERRCODE_SUCC) {
        osal_printk("%s enable_sle fail\r\n", SLE_LINK_LOG);
        return -1;
    }
    set_local_addr(SFC1_SLE_LOCAL_ADDR_CONFIRM); /* 同步路径先设；enable 回调会再设一次兜底 */
    ret = server_register_callbacks();
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s register callbacks fail 0x%x\r\n", SLE_LINK_LOG, (unsigned)ret);
        return -1;
    }

    (void)memset_s(&app_uuid, sizeof(app_uuid), 0, sizeof(app_uuid));
    app_uuid.len = sizeof(g_app_uuid);
    if (memcpy_s(app_uuid.uuid, sizeof(app_uuid.uuid), g_app_uuid, sizeof(g_app_uuid)) != EOK) {
        return -1;
    }
    ret = ssaps_register_server(&app_uuid, &g_server_id);
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s register server fail 0x%x\r\n", SLE_LINK_LOG, (unsigned)ret);
        return -1;
    }
    ret = server_service_add();
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s add service fail 0x%x\r\n", SLE_LINK_LOG, (unsigned)ret);
        (void)ssaps_unregister_server(g_server_id);
        return -1;
    }
    ret = ssaps_start_service(g_server_id, g_service_handle);
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s start service fail 0x%x\r\n", SLE_LINK_LOG, (unsigned)ret);
        (void)ssaps_unregister_server(g_server_id);
        return -1;
    }
    if (announce_param_set() != 0 || announce_data_set() != 0) {
        osal_printk("%s announce config fail\r\n", SLE_LINK_LOG);
        return -1;
    }
    ret = sle_start_announce(SLE_ADV_HANDLE_DEFAULT);
    if (ret != ERRCODE_SLE_SUCCESS) {
        osal_printk("%s start announce fail 0x%x\r\n", SLE_LINK_LOG, (unsigned)ret);
        return -1;
    }
    osal_printk("%s role=server ready name=%s\r\n", SLE_LINK_LOG, g_name);
    return 0;
}

/* ============================ client ============================ */

static void client_start_scan(void)
{
    sle_seek_param_t param;

    (void)memset_s(&param, sizeof(param), 0, sizeof(param));
    param.own_addr_type = 0;
    param.filter_duplicates = 0;
    param.seek_filter_policy = 0;
    param.seek_phys = 1;
    param.seek_type[0] = 1;
    param.seek_interval[0] = SLE_SEEK_INTERVAL_DEFAULT;
    param.seek_window[0] = SLE_SEEK_WINDOW_DEFAULT;
    (void)sle_set_seek_param(&param);
    (void)sle_start_seek();
    osal_printk("%s role=client scanning name=%s\r\n", SLE_LINK_LOG, g_name);
}

static void client_notification_cbk(uint8_t client_id,
                                    uint16_t conn_id,
                                    ssapc_handle_value_t *data,
                                    errcode_t status)
{
    unused(client_id);
    unused(conn_id);
    if (status != ERRCODE_SLE_SUCCESS || data == NULL || data->data == NULL || data->data_len == 0) {
        return;
    }
    if (g_rx_cb != NULL) {
        g_rx_cb(data->data, data->data_len);
    }
}

static void client_write_cfm_cbk(uint8_t client_id,
                                 uint16_t conn_id,
                                 ssapc_write_result_t *write_result,
                                 errcode_t status)
{
    unused(client_id);
    unused(conn_id);
    unused(write_result);
    unused(status);
}

static void client_seek_enable_cbk(errcode_t status)
{
    if (status != 0) {
        osal_printk("%s seek enable error 0x%x\r\n", SLE_LINK_LOG, (unsigned)status);
    }
}

static void client_seek_result_cbk(sle_seek_result_info_t *result)
{
    if (result == NULL || result->data == NULL) {
        return;
    }
    if (!adv_name_matches(result->data, result->data_length)) {
        return;
    }
    osal_printk("%s found %s, stop seek\r\n", SLE_LINK_LOG, g_name);
    if (memcpy_s(&g_remote_addr, sizeof(g_remote_addr), &result->addr, sizeof(sle_addr_t)) != EOK) {
        return;
    }
    (void)sle_stop_seek();
}

static void client_seek_disable_cbk(errcode_t status)
{
    if (status != 0) {
        osal_printk("%s seek disable error 0x%x\r\n", SLE_LINK_LOG, (unsigned)status);
        return;
    }
    (void)sle_remove_paired_remote_device(&g_remote_addr);
    osal_printk("%s connecting...\r\n", SLE_LINK_LOG);
    (void)sle_connect_remote_device(&g_remote_addr);
}

static void client_sle_enable_cbk(errcode_t status)
{
    osal_printk("%s sle enable status=%d\r\n", SLE_LINK_LOG, (int)status);
    if (status == 0) {
        set_local_addr(SFC1_SLE_LOCAL_ADDR_EXEC);
        client_start_scan();
    }
}

static void client_seek_cbks_register(void)
{
    (void)memset_s(&g_seek_cbk, sizeof(g_seek_cbk), 0, sizeof(g_seek_cbk));
    g_seek_cbk.sle_enable_cb = client_sle_enable_cbk;
    g_seek_cbk.seek_enable_cb = client_seek_enable_cbk;
    g_seek_cbk.seek_result_cb = client_seek_result_cbk;
    g_seek_cbk.seek_disable_cb = client_seek_disable_cbk;
    (void)sle_announce_seek_register_callbacks(&g_seek_cbk);
}

static void client_connect_state_cbk(uint16_t conn_id,
                                     const sle_addr_t *addr,
                                     sle_acb_state_t conn_state,
                                     sle_pair_state_t pair_state,
                                     sle_disc_reason_t disc_reason)
{
    unused(addr);
    osal_printk("%s conn state=0x%x pair=0x%x reason=0x%x conn=0x%x\r\n", SLE_LINK_LOG,
                (unsigned)conn_state, (unsigned)pair_state, (unsigned)disc_reason, (unsigned)conn_id);

    g_conn_id = conn_id;
    if (conn_state == SLE_ACB_STATE_CONNECTED) {
        if (pair_state == SLE_PAIR_NONE) {
            osal_printk("%s pairing...\r\n", SLE_LINK_LOG);
            (void)sle_pair_remote_device(&g_remote_addr);
        }
    } else if (conn_state == SLE_ACB_STATE_DISCONNECTED) {
        if (g_connected) {
            g_connected = 0;
            sle_link_report_state(0);
        }
        g_write_ready = 0;
        g_conn_id = 0;
        (void)sle_remove_paired_remote_device(&g_remote_addr);
        client_start_scan();
    }
}

static void client_pair_complete_cbk(uint16_t conn_id, const sle_addr_t *addr, errcode_t status)
{
    ssap_exchange_info_t info;

    unused(addr);
    osal_printk("%s pair complete conn=0x%x status=0x%x\r\n", SLE_LINK_LOG, (unsigned)conn_id, (unsigned)status);
    if (status == ERRCODE_SLE_SUCCESS) {
        (void)memset_s(&info, sizeof(info), 0, sizeof(info));
        info.mtu_size = SFC1_SLE_MTU;
        info.version = 1;
        (void)ssapc_exchange_info_req(0, g_conn_id, &info);
    }
}

static void client_connect_cbks_register(void)
{
    (void)memset_s(&g_connect_cbk, sizeof(g_connect_cbk), 0, sizeof(g_connect_cbk));
    g_connect_cbk.connect_state_changed_cb = client_connect_state_cbk;
    g_connect_cbk.pair_complete_cb = client_pair_complete_cbk;
    (void)sle_connection_register_callbacks(&g_connect_cbk);
}

static void client_exchange_info_cbk(uint8_t client_id,
                                     uint16_t conn_id,
                                     ssap_exchange_info_t *param,
                                     errcode_t status)
{
    ssapc_find_structure_param_t find_param;

    unused(client_id);
    osal_printk("%s exchange info conn=0x%x mtu=%u status=0x%x\r\n", SLE_LINK_LOG, (unsigned)conn_id,
                param == NULL ? 0u : (unsigned)param->mtu_size, (unsigned)status);
    if (status != ERRCODE_SLE_SUCCESS) {
        return;
    }
    (void)memset_s(&find_param, sizeof(find_param), 0, sizeof(find_param));
    find_param.type = SSAP_FIND_TYPE_PROPERTY;
    find_param.start_hdl = 1;
    find_param.end_hdl = 0xFFFF;
    (void)ssapc_find_structure(0, conn_id, &find_param);
}

static void client_find_structure_cbk(uint8_t client_id,
                                      uint16_t conn_id,
                                      ssapc_find_service_result_t *service,
                                      errcode_t status)
{
    unused(client_id);
    unused(conn_id);
    if (status != ERRCODE_SLE_SUCCESS || service == NULL) {
        return;
    }
    g_find_service_result.start_hdl = service->start_hdl;
    g_find_service_result.end_hdl = service->end_hdl;
    (void)memcpy_s(&g_find_service_result.uuid, sizeof(sle_uuid_t), &service->uuid, sizeof(sle_uuid_t));
}

static void client_find_property_cbk(uint8_t client_id,
                                     uint16_t conn_id,
                                     ssapc_find_property_result_t *property,
                                     errcode_t status)
{
    unused(client_id);
    unused(conn_id);
    if (status != ERRCODE_SLE_SUCCESS || property == NULL) {
        return;
    }
    g_write_param.handle = property->handle;
    g_write_param.type = SSAP_PROPERTY_TYPE_VALUE;
}

static void client_find_structure_cmp_cbk(uint8_t client_id,
                                          uint16_t conn_id,
                                          ssapc_find_structure_result_t *structure_result,
                                          errcode_t status)
{
    unused(structure_result);
    osal_printk("%s discovery complete client=%u conn=0x%x status=0x%x\r\n", SLE_LINK_LOG,
                (unsigned)client_id, (unsigned)conn_id, (unsigned)status);
    if (status == ERRCODE_SLE_SUCCESS) {
        g_write_ready = 1;
        if (!g_connected) {
            g_connected = 1;
            sle_link_report_state(1);
        }
    }
}

static void client_ssapc_cbks_register(void)
{
    (void)memset_s(&g_ssapc_cbk, sizeof(g_ssapc_cbk), 0, sizeof(g_ssapc_cbk));
    g_ssapc_cbk.exchange_info_cb = client_exchange_info_cbk;
    g_ssapc_cbk.find_structure_cb = client_find_structure_cbk;
    g_ssapc_cbk.ssapc_find_property_cbk = client_find_property_cbk;
    g_ssapc_cbk.find_structure_cmp_cb = client_find_structure_cmp_cbk;
    g_ssapc_cbk.notification_cb = client_notification_cbk;
    g_ssapc_cbk.indication_cb = NULL;
    g_ssapc_cbk.write_cfm_cb = client_write_cfm_cbk;
    (void)ssapc_register_callbacks(&g_ssapc_cbk);
}

static int client_start(void)
{
    /* 厂商样例在 enable_sle 前等待 SLE core ready；这里保留同样节奏。 */
    (void)osal_msleep(SLE_CORE_READY_WAIT_MS);

    client_seek_cbks_register();
    client_connect_cbks_register();
    client_ssapc_cbks_register();

    if (enable_sle() != ERRCODE_SUCC) {
        osal_printk("%s enable_sle fail\r\n", SLE_LINK_LOG);
        return -1;
    }
    set_local_addr(SFC1_SLE_LOCAL_ADDR_EXEC); /* 同步路径先设；enable 回调会再设一次兜底 */
    osal_printk("%s role=client init done, waiting for scan\r\n", SLE_LINK_LOG);
    return 0;
}

/* ============================ public ============================ */

int sle_link_server_start(const char *name, sle_link_rx_cb rx_cb, sle_link_state_cb state_cb)
{
    if (g_mode != SLE_LINK_MODE_NONE) {
        return -1;
    }
    g_mode = SLE_LINK_MODE_SERVER;
    g_rx_cb = rx_cb;
    g_state_cb = state_cb;
    copy_name(name);
    return server_start();
}

int sle_link_client_start(const char *name, sle_link_rx_cb rx_cb, sle_link_state_cb state_cb)
{
    if (g_mode != SLE_LINK_MODE_NONE) {
        return -1;
    }
    g_mode = SLE_LINK_MODE_CLIENT;
    g_rx_cb = rx_cb;
    g_state_cb = state_cb;
    copy_name(name);
    return client_start();
}

int sle_link_send(const uint8_t *data, uint16_t len)
{
    if (data == NULL || len == 0 || len > sizeof(g_tx_buf) || !g_connected) {
        return -1;
    }
    if (memcpy_s(g_tx_buf, sizeof(g_tx_buf), data, len) != EOK) {
        return -1;
    }

    if (g_mode == SLE_LINK_MODE_SERVER) {
        ssaps_ntf_ind_t param;
        (void)memset_s(&param, sizeof(param), 0, sizeof(param));
        param.handle = g_property_handle;
        param.type = SSAP_PROPERTY_TYPE_VALUE;
        param.value = g_tx_buf;
        param.value_len = len;
        return ssaps_notify_indicate(g_server_id, g_conn_id, &param) == ERRCODE_SLE_SUCCESS ? 0 : -1;
    }
    if (g_mode == SLE_LINK_MODE_CLIENT) {
        if (!g_write_ready) {
            return -1;
        }
        g_write_param.data = g_tx_buf;
        g_write_param.data_len = len;
        return ssapc_write_req(0, g_conn_id, &g_write_param) == ERRCODE_SLE_SUCCESS ? 0 : -1;
    }
    return -1;
}

int sle_link_is_connected(void)
{
    return g_connected ? 1 : 0;
}

#else /* !SFC1_WITH_LINK */

typedef int sfc1_sle_link_disabled_t;

#endif /* SFC1_WITH_LINK */
