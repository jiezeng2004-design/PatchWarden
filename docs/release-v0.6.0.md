# PatchWarden v0.6.0

PatchWarden v0.6.0 在保持 `chatgpt_core` 固定 16 工具兼容的同时，加入默认关闭的
`chatgpt_direct` 安全直接开发模式、本地 assess → confirm → execute 闭环，以及更可靠的
Windows Core/Direct 双通道运行管理。

## 主要更新

### ChatGPT Core 安全体验

- `assess_only` 返回最小化的结构化 `next_tool_call`；execute 只需
  `execution_mode` 和完整 `assessment_id`，不再重复传输目标、计划和仓库参数。
- 中风险票据通过本地 `patchwarden-confirm <full_assessment_id>` 确认。该入口不是 MCP
  工具，远程调用者不能自行放行。
- 确认和执行会重新校验票据时效、工作区、计划、策略和工具 Manifest。
- `audit_task` 将已确认失败、可能误报和人工核查项分开呈现。
- `get_task_summary(view: "compact")` 和终态 `wait_for_task` 返回有界验收证据，避免长任务
  结果淹没客户端上下文。

### ChatGPT Direct 模式

- 默认关闭；启用需设置 `enableDirectProfile: true` 并使用 `chatgpt_direct` Profile。
- 固定 9 工具：健康检查、工作区列表、会话创建、搜索、文件读取、JSON 补丁、白名单
  验证、会话完成和独立审计。
- 所有写操作绑定 Direct session 和内容哈希；不支持任意 shell、删除/重命名、Git 推送、
  npm 发布或远程部署。

### Windows Core/Direct 控制与可观测性

- 根目录统一使用 `PatchWarden.cmd`，支持 Core、Direct 或两者的
  `start`、`stop`、`restart`、`status`、`health` 和受限 `kill`。
- Core 和 Direct 分别使用 `127.0.0.1:8080` 与 `127.0.0.1:8081`，并自动校正各自
  tunnel profile 的 health 地址。
- supervisor 将 stdout/stderr 写入各自 runtime 目录；非零退出时显示 stderr 最后 30 行，
  并把退出码、脱敏 tail 和日志路径写入 `tunnel-status.json`。
- 修复 Core watcher 的 `XDG_CONFIG_HOME` 泄漏到 tunnel-client，导致 Core 错误读取
  `%LOCALAPPDATA%\patchwarden\opencode-config\tunnel-client\patchwarden.yaml` 并反复退出的问题。
- `stop` / `restart` 可清理 Profile 精确匹配的遗留 tunnel-client；无关端口占用只报告、不误杀。
- `status` 支持 health endpoint fallback，陈旧 JSON 不再把实际 ready 的实例误报为 stopped。
- 旧的单用途入口迁入 `scripts/launchers/`；个人 `.local/launchers/`、运行时配置、凭据和日志
  不进入 Git、npm 包或 GitHub 发布资产。

## 兼容性

- `chatgpt_core` 仍为固定 16 工具；`chatgpt_direct` 为固定 9 工具。
- schema epoch 为 `2026-06-22-v6`。
- `assess_only`、`execute`、`assessment_id`、`plan_ref` 和既有任务记录保持兼容。
- npm 包名保持 `patchwarden`；旧的 `safe-bifrost` 包继续冻结在 v0.3.0。

## 验证

发布候选通过以下门禁：

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run check:tool-manifest
npm.cmd run check:direct-tool-manifest
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run pack:clean
npm.cmd run verify:package
git diff --check
```

本机双通道验收确认 Core 16 工具和 Direct 9 工具均为 `running`、`ready=true`，8080/8081
由对应 `tunnel-client.exe` 监听，两个 `/readyz` 均返回 `ready`。

GitHub Release 与 npm Registry 是独立发布面。创建 Tag/Release 不会自动发布 npm；npm 发布后
仍需单独核对 `patchwarden@latest`、版本时间、dist-tag 和包完整性。
