# PatchWarden 质量审计问题解决方案

## 概述

基于现场质量审计报告发现的问题，本计划将按优先级逐个解决：

1. **npm keywords 补全**（简单，优先级最高）
2. **合并 PR #22 / 推进 v1.5.0 发布**
3. **controlCenter.ts 模块拆分**（主要重构工作）

---

## 当前状态分析

### 问题1: npm keywords 不完整
- **现状**: `package.json` keywords 只有 5 个 (`mcp, model-context-protocol, codex, opencode, local-agent`)
- **目标**: 应与 GitHub topics (14个) 保持一致，优化 npm 搜索可见性
- **GitHub topics**: `security, automation, typescript, mcp, opencode, learn, ai-agents, local-first, github-copilot, chatgpt, model-context-protocol, mcp-server, local-agents, safe-summaries`

### 问题2: PR #22 未合并，发布节奏受阻
- **现状**: 本地 main 分支处于 v1.1.0，工作树干净，没有 v1.5.0 的相关代码
- **GitHub PR #22**: "Release PatchWarden v1.5.0"，处于 Open 状态，Jul 5 创建
- **需要**: 检查是否需要本地创建 v1.5.0 的变更，或者这是远程分支的工作

### 问题3: controlCenter.ts 74.8KB（2166行）过大
- **现状**: 单文件包含大量功能模块：
  - HTTP 服务器路由（900+ 行）
  - API handlers（约 20 个 handler 函数）
  - Direct sessions 管理
  - Task 状态管理
  - Stale task 分类
  - manage-patchwarden.ps1 调用
  - Static file serving
  - Health probing
  - 事件记录
- **目标**: 拆分成多个子模块，提升可维护性

---

## 实施方案

### 第一阶段: npm keywords 补全（快速修复）

**文件**: `/workspace/package.json`

**变更内容**:
```json
"keywords": [
  "mcp",
  "model-context-protocol",
  "mcp-server",
  "security",
  "automation",
  "typescript",
  "ai-agents",
  "local-first",
  "local-agents",
  "safe-summaries",
  "github-copilot",
  "chatgpt",
  "codex",
  "opencode"
]
```

**理由**: 与 GitHub topics 保持一致，提升 npm 搜索可见性

---

### 第二阶段: 发布流程确认

**步骤**:
1. 确认本地没有 v1.5.0 相关变更（已确认）
2. 建议用户在 GitHub 上检查 PR #22 的状态和内容
3. 如果 PR #22 已准备好，建议合并流程：
   - 确认 CI 通过
   - 审查 diff 和 package contents
   - 合并 PR
   - 创建 tag 和 GitHub Release
   - 发布到 npm
   - 验证 remote 状态

**注意**: 此阶段需要在 GitHub 网页端操作，本地无法直接处理远程 PR

---

### 第三阶段: controlCenter.ts 模块拆分（主要重构）

#### 3.1 拆分策略

将 `controlCenter.ts` 拆分成以下模块：

| 新模块文件 | 职责 | 行数估算 |
|-----------|------|---------|
| `src/controlCenter/server.ts` | HTTP server 创建、路由、shutdown | ~150 |
| `src/controlCenter/apiHandlers.ts` | 所有 API handler 函数 (handleTasks, handleStaleTasks, handleReconcile, etc.) | ~400 |
| `src/controlCenter/directSessions.ts` | Direct session 读取、处理 | ~150 |
| `src/controlCenter/taskManagement.ts` | Task stale 分类、reconcile | ~150 |
| `src/controlCenter/staticServing.ts` | Static file serving, favicon | ~80 |
| `src/controlCenter/manageProcess.ts` | manage-patchwarden.ps1 调用 | ~100 |
| `src/controlCenter/statusEvents.ts` | Status file, events 记录 | ~150 |
| `src/controlCenter/healthProbing.ts` | Health probing, suggestions | ~150 |
| `src/controlCenter/helpers.ts` | 工具函数 (errorMessage, readJsonFileSafe, etc.) | ~120 |
| `src/controlCenter.ts` | 入口：导入并组装各模块 | ~50 |

#### 3.2 实施步骤

1. 创建 `src/controlCenter/` 目录
2. 按职责拆分代码到各子模块
3. 每个子模块 export 相关函数和类型
4. 主文件 `src/controlCenter.ts` 改为导入并组装
5. 运行 TypeScript 编译检查
6. 运行 `npm test` 确保不破坏现有功能
7. 运行 `npm run control-center-smoke.js` 验证

#### 3.3 保持的接口

- 对外暴露的 HTTP API 路由不变
- `dist/controlCenter.js` 入口路径不变
- 所有 API handler 行为不变

---

## 假设与决策

### 假设
1. 用户有权限在 GitHub 上操作 PR #22
2. PR #22 的内容已在远程分支准备就绪
3. controlCenter.ts 拆分不会破坏现有 API 接口

### 决策
1. keywords 补全：直接与 GitHub topics 同步
2. 发布流程：建议用户在 GitHub 网页端操作
3. controlCenter 拆分：创建子模块目录结构，保持接口兼容

---

## 验证步骤

### 第一阶段验证
- `npm run build` 确认编译成功
- `npm run pack:clean` 确认 keywords 更新在 package 中

### 第二阶段验证
- 在 GitHub 上确认 CI 通过
- 合并后验证 npm 发布状态

### 第三阶段验证
- `npm run build` 确认编译成功
- `npm test` 确认所有测试通过
- `npm run test:control-center-smoke` 确认控制中心功能正常
- 手动启动 control center 验证 API 可访问

---

## 实施顺序

1. ✅ **Phase 1**: npm keywords 补全（立即执行）
2. ⏸️ **Phase 2**: 发布流程指导（需要用户在 GitHub 操作）
3. 🔄 **Phase 3**: controlCenter.ts 拆分（需要较多时间，逐步实施）

---

## 时间估算

| 阶段 | 估算时间 |
|------|---------|
| Phase 1 | ~5 分钟 |
| Phase 2 | 需用户在 GitHub 操作 |
| Phase 3 | ~30-60 分钟（拆分 + 测试验证）|

---

## 注意事项

- Phase 3 的拆分是较大重构，建议在单独分支或 PR 中进行
- 每个阶段完成后运行完整的质量检查
- Phase 2 需要用户在 GitHub 网页端确认 PR #22 的内容和状态