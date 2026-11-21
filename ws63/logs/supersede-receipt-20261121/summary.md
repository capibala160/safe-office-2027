| 项 | 结果 |
|---|---|
| 旧挑战失效 | PASS |
| 旧挑战不能被批准（PC 拒绝） | PASS |
| 收件人前后对照 | PASS |
| 同名附件替换（移除 + 加入） | PASS |
| 新挑战目标哈希 = 新操作哈希 | PASS |
| 新版本真板批准 | PASS |
| 执行完成 + outbox 已发送 | PASS |
| 回执（confirmationId + messageId） | PASS |
| 审计链校验 | PASS |

收件人：partner@partner-example.com → review@partner-example.com
附件：agenda.txt → agenda.txt
- 已移除：agenda.txt sha256=9d6e9dbab9df…
- 已加入：agenda.txt sha256=d035eacdbabd…
旧挑战：ce0d977dbd96…；旧操作：24e75912-d129-4aff-908f-544d19efa519
新挑战：15875dbc7e2d…；新操作：6d09515d-5aff-4baf-b64a-9e401619bdf7
回执：confirmationId=ws63-5c1331edd27d2d58-15875dbc7e2d077b34b4034d8dcf5d89 messageId=fake-message-1-1
