# MCP 配置持久化（v0.40）

> v0.36 的 MCP 注册是纯内存态：进程一重启，工具注册表清空，得重新发现/注册一遍。
> 本轮把注册配置落盘，启动时自动重连。

## 1. 落盘格式

默认 `prototype/data/mcp-servers.json`（`SAFE_OFFICE_MCP_FILE` 可改，已 gitignore）：

```json
{
  "version": 1,
  "servers": [
    {
      "url": "http://127.0.0.1:7899/",
      "token": "***",
      "tools": ["wordCount"],
      "roles": ["员工"],
      "level": "L1",
      "capability": "MCP 外部工具",
      "registeredAt": "2026-10-31T..."
    }
  ]
}
```

- 文件权限 `0600`（Windows 上受文件系统语义限制）。
- **token 明文保存**——与 `config.env` 同口径：只在本机、不进仓库；丢文件等于要重新注册。
- 同一 URL + 同一工具集合再次注册 → 覆盖该条（可换 token/角色/级别）；不同工具集合 → 追加一条。
- **保存失败如实返回** `persisted:false` + `persistError`；该条会从内存配置列表移除（不冒充已持久化），
  工具仍留在内存注册表中，审计写 `MCP 配置保存失败`。返回里的 `persistEnabled` 区分"未启用持久化"与"落盘失败"。

## 2. 启动恢复

`ConsoleService` 构造时读取配置，并挂 `mcpRestorePromise`：

1. `server.cjs` 在监听前 `await` 这个 Promise（单个服务失败不阻塞启动）；
2. 每条配置走与手动注册相同的内核 `_applyMcpRegistration`（同样的 URL 校验、角色校验、沙箱/策略）；
3. 成功 → 审计 `MCP 恢复`；失败 → 审计 `MCP 恢复失败`，记入 `mcpRestore.failed`；
4. 配置文件损坏 → 记 `mcpConfigError`，审计 `MCP 配置加载` 带错误，空表继续启动。

`npm start` 启动日志会打印：

```
MCP 配置：...\data\mcp-servers.json（1 个服务，恢复 1 个工具）
```

治理页「接入 MCP 服务」卡片显示已持久化的服务 URL；有恢复失败时显示红色提示与原因。

## 3. 验证

```bash
npm test        # 367 项：365 通过 + 2 跳过（ClamAV / 真实 Edge 默认跳过）
```

新增 `test/mcp-persistence.test.cjs` 6 项：

- 注册后文件内容完整（URL/工具/角色/级别/token）；
- 重启恢复：注册表、策略、执行器全部回来，且用持久化的 token 调通真实 HTTP 工具；
- MCP 服务不可用：启动不崩、失败计数/审计正确、控制台仍可用；
- 配置文件损坏：不崩、错误可见、`mcpServers` 为空；
- 不配文件路径：注册照常工作，只是不落盘（`persistEnabled:false`，不算失败）；
- **保存失败：`persisted:false`、不留假条目、工具仍在内存、审计留痕**。

## 4. 边界

- **token 明文**，没有加密/系统密钥环；`data/` 丢失或泄露需视为凭据泄露。
- 没有删除/编辑 UI：改配置要手工改 `mcp-servers.json` 后重启；同工具重复注册仍是 409。
- 启动时服务不可用 → 该次工具不注册；需要重启控制台或重新发现/注册。
- 远程地址开关 `SAFE_OFFICE_MCP_ALLOW_REMOTE` 必须与注册时一致，否则恢复会按"只允许回环"拒绝。
- 仍是 JSON-RPC over HTTP；SSE/stdio/OAuth/断线重连未做。
