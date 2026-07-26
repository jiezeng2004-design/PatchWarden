# PatchWarden Website

PatchWarden 的现代化单页项目展示网站，位于主仓库的 `website/` 目录，
面向潜在用户和开源贡献者。

## 页面内容

- 多 Agent 安全执行与验收定位
- Codex、Claude Code、OpenCode 支持矩阵
- 风险预检、文件快照、测试验证与审计证据
- `chatgpt_delegate` / `chatgpt_direct` 两种控制模式
- Windows、源码和 npm 三种安装入口
- 响应式布局与安装命令复制交互

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

开发服务器启动后，打开终端给出的本地地址。

## 构建检查

```bash
npm run lint
npm run build
npm run validate:artifact
```

主要页面代码位于：

- `app/page.tsx`
- `app/globals.css`
- `app/layout.tsx`

## 版本与下载同步

- 页面启动时从 GitHub `releases/latest` 读取最新正式版本。
- GitHub API 不可用时回退到仓库已确认的 `v1.6.3`。
- Windows 安装命令自动选择最新 Release 中的 x64 安装包，不写死版本号。

发布 `v1.6.4` 后，只要 GitHub Release 和安装包资产命名保持现有规则，
网站无需再手工修改版本文本或下载 URL。
