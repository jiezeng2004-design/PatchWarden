"use client";

import { useEffect, useState } from "react";

const githubUrl = "https://github.com/jiezeng2004-design/PatchWarden";
const latestReleaseApi = `${githubUrl.replace("github.com", "api.github.com/repos")}/releases/latest`;
const fallbackVersion = "1.6.3";

const agents = [
  {
    name: "Codex",
    short: "CX",
    tone: "blue",
    description: "适合仓库级实现、调试与验证，通过统一适配层接入受控任务循环。",
    meta: ["原生适配", "任务循环", "验证回传"],
  },
  {
    name: "Claude Code",
    short: "CL",
    tone: "orange",
    description: "保留熟悉的本地编码体验，同时增加范围约束、快照与审计证据。",
    meta: ["CLI 适配", "范围控制", "失败收敛"],
  },
  {
    name: "OpenCode",
    short: "OC",
    tone: "cyan",
    description: "面向开放模型与多 Provider 工作流，在同一套安全策略下稳定执行。",
    meta: ["开放生态", "统一策略", "执行报告"],
  },
];

const evidence = [
  ["status.json", "任务状态、阶段、心跳与错误信息", "实时"],
  ["result.json", "结构化结果、路径、改动与警告", "结构化"],
  ["diff.patch", "完整且有界的任务差异证据", "已脱敏"],
  ["verify.json", "独立测试命令与验证结果", "已验证"],
];

const installOptions = {
  windows: {
    label: "Windows",
    eyebrow: "推荐首次体验",
    description: "自动获取 GitHub 最新正式版安装包，发布 1.6.4 后无需修改命令。",
    command:
      '$release = Invoke-RestMethod "https://api.github.com/repos/jiezeng2004-design/PatchWarden/releases/latest"\n$asset = $release.assets | Where-Object { $_.name -match "^PatchWarden-Setup-.*-x64\\.exe$" } | Select-Object -First 1\nInvoke-WebRequest -Uri $asset.browser_download_url -OutFile "PatchWarden-Setup.exe"',
  },
  source: {
    label: "源码运行",
    eyebrow: "适合贡献者",
    description: "克隆仓库、安装依赖并启动健康检查。",
    command:
      "git clone https://github.com/jiezeng2004-design/PatchWarden.git\ncd PatchWarden\nnpm install\nnpm run build\nnpm run doctor",
  },
  npm: {
    label: "npm",
    eyebrow: "适合集成",
    description: "直接安装包并在本地工作区启动 Watcher。",
    command: "npm install -g patchwarden\npatchwarden doctor\npatchwarden watch",
  },
};

type InstallKey = keyof typeof installOptions;

function ShieldMark() {
  return (
    <span className="shield-mark" aria-hidden="true">
      <span>W</span>
    </span>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  const [installTab, setInstallTab] = useState<InstallKey>("windows");
  const [copied, setCopied] = useState(false);
  const [latestVersion, setLatestVersion] = useState(fallbackVersion);
  const currentInstall = installOptions[installTab];

  useEffect(() => {
    const controller = new AbortController();

    fetch(latestReleaseApi, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load the latest release");
        return response.json() as Promise<{ tag_name?: string }>;
      })
      .then((release) => {
        const version = release.tag_name?.replace(/^v/, "").trim();
        if (version) setLatestVersion(version);
      })
      .catch(() => {
        // Keep the repository-confirmed fallback when GitHub is unavailable.
      });

    return () => controller.abort();
  }, []);

  async function copyCommand() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(currentInstall.command);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = currentInstall.command;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        textArea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main>
      <header className="site-header">
        <div className="shell nav-inner">
          <a className="brand" href="#top" aria-label="PatchWarden 首页">
            <ShieldMark />
            <span>PatchWarden</span>
          </a>
          <nav className="desktop-nav" aria-label="主导航">
            <a href="#capabilities">核心能力</a>
            <a href="#agents">Agent</a>
            <a href="#architecture">工作流</a>
            <a href="#install">安装</a>
          </nav>
          <a className="nav-button" href={githubUrl} target="_blank" rel="noreferrer">
            <span className="github-dot" aria-hidden="true">⌁</span>
            GitHub
            <ArrowIcon />
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-orb hero-orb-one" aria-hidden="true" />
        <div className="hero-orb hero-orb-two" aria-hidden="true" />
        <div className="shell hero-layout">
          <div className="hero-copy">
            <div className="release-pill">
              <span className="pulse-dot" />
              <span>PatchWarden v{latestVersion}</span>
              <span className="pill-divider" />
              <span>本地优先</span>
            </div>
            <h1>
              让每一次 AI 改代码，
              <span>都可控、可追踪，</span>
              <span>可验收。</span>
            </h1>
            <p className="hero-lead">
              连接 ChatGPT 与本地编码 Agent 的安全执行与验收层。统一调度
              Codex、Claude Code、OpenCode，在明确边界内执行，并留下完整证据。
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#install">
                快速开始 <span aria-hidden="true">→</span>
              </a>
              <a className="button button-ghost" href={githubUrl} target="_blank" rel="noreferrer">
                查看源代码 <ArrowIcon />
              </a>
            </div>
            <div className="hero-trust">
              <span>支持</span>
              <strong>Codex</strong>
              <i />
              <strong>Claude Code</strong>
              <i />
              <strong>OpenCode</strong>
            </div>
          </div>

          <div className="hero-console-wrap">
            <div className="console-glow" />
            <div className="console-window">
              <div className="console-bar">
                <div className="window-dots"><i /><i /><i /></div>
                <span>controlled-task-loop</span>
                <span className="secure-chip">● SECURE</span>
              </div>
              <div className="console-body">
                <div className="task-heading">
                  <div>
                    <span className="micro-label">TASK PW-0184</span>
                    <h2>修复认证状态同步问题</h2>
                  </div>
                  <span className="risk-badge">低风险</span>
                </div>
                <div className="agent-route">
                  <span className="route-node user-node">ChatGPT</span>
                  <span className="route-line"><i /></span>
                  <span className="route-node warden-node"><ShieldMark />Warden</span>
                  <span className="route-line"><i /></span>
                  <span className="route-node agent-node">Codex</span>
                </div>
                <div className="progress-list">
                  <div className="progress-row done">
                    <span className="status-icon">✓</span>
                    <div><strong>风险预检</strong><small>范围与命令策略通过</small></div>
                    <code>42ms</code>
                  </div>
                  <div className="progress-row done">
                    <span className="status-icon">✓</span>
                    <div><strong>Agent 执行</strong><small>3 个文件发生改动</small></div>
                    <code>18.4s</code>
                  </div>
                  <div className="progress-row active">
                    <span className="status-icon spinner" />
                    <div><strong>独立验证</strong><small>npm test · 38/38 passed</small></div>
                    <code>运行中</code>
                  </div>
                </div>
                <div className="console-footer">
                  <span><i className="green-dot" /> Watcher healthy</span>
                  <span>scope: patchwarden-demo</span>
                </div>
              </div>
            </div>
            <div className="floating-card floating-top">
              <span className="floating-icon">✓</span>
              <div><strong>策略已通过</strong><small>无越界访问</small></div>
            </div>
            <div className="floating-card floating-bottom">
              <span className="file-icon">⌘</span>
              <div><strong>diff.patch</strong><small>证据已脱敏</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="metric-strip" aria-label="项目特征">
        <div className="shell metrics">
          <div><strong>3+</strong><span>主流编码 Agent</span></div>
          <div><strong>2</strong><span>受控执行模式</span></div>
          <div><strong>5</strong><span>任务安全阶段</span></div>
          <div><strong>100%</strong><span>本地工作区优先</span></div>
        </div>
      </section>

      <section className="section section-light" id="capabilities">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <span className="eyebrow">WHY PATCHWARDEN</span>
              <h2>在 Agent 的能力与<br />仓库的边界之间。</h2>
            </div>
            <p>
              Agent 很强，但生产仓库需要的不只是“能改代码”。PatchWarden 把风险判断、权限控制、执行、验证和审计组织成一个可复核的闭环。
            </p>
          </div>
          <div className="capability-grid">
            <article className="capability-card featured-card">
              <div className="card-number">01</div>
              <div className="capability-visual risk-visual">
                <span className="risk-ring ring-one" />
                <span className="risk-ring ring-two" />
                <span className="risk-core"><ShieldMark /></span>
                <span className="risk-label risk-low">LOW</span>
                <span className="risk-label risk-mid">REVIEW</span>
                <span className="risk-label risk-high">BLOCK</span>
              </div>
              <h3>风险预检与硬边界</h3>
              <p>白名单命令、敏感路径保护、工作区约束与二次校验，在 Agent 启动前先判断风险。</p>
              <div className="card-tags"><span>硬规则</span><span>高风险拦截</span></div>
            </article>
            <article className="capability-card">
              <div className="card-number">02</div>
              <div className="capability-visual snapshot-visual">
                <div className="diff-line"><i>+</i><span /></div>
                <div className="diff-line"><i>+</i><span /></div>
                <div className="diff-line removed"><i>−</i><span /></div>
                <div className="snapshot-badge">Git snapshot</div>
              </div>
              <h3>改动快照与作用域检测</h3>
              <p>执行前后自动对比文件状态。任何工作区外变化都会被标记，而不是被悄悄接受。</p>
              <div className="card-tags"><span>只读快照</span><span>Diff 脱敏</span></div>
            </article>
            <article className="capability-card">
              <div className="card-number">03</div>
              <div className="capability-visual verify-visual">
                <div className="verify-score">38<span>/38</span></div>
                <div className="verify-bars"><i /><i /><i /><i /><i /></div>
                <small>ALL TESTS PASSED</small>
              </div>
              <h3>独立验证与验收报告</h3>
              <p>按白名单执行测试，汇总结果、Diff 与警告，让上游模型和人都能重新验收。</p>
              <div className="card-tags"><span>测试验证</span><span>结构化报告</span></div>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-agents" id="agents">
        <div className="shell">
          <div className="section-heading centered-heading">
            <span className="eyebrow">MULTI-AGENT ROUTING</span>
            <h2>一个安全层，连接你熟悉的 Agent。</h2>
            <p>无需改变原有工具习惯，用统一策略调度不同执行器。</p>
          </div>
          <div className="agent-grid">
            {agents.map((agent) => (
              <article className="agent-card" key={agent.name}>
                <div className={`agent-avatar ${agent.tone}`}>{agent.short}</div>
                <div className="agent-status"><i /> READY</div>
                <h3>{agent.name}</h3>
                <p>{agent.description}</p>
                <ul>
                  {agent.meta.map((item) => <li key={item}>✓ {item}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section workflow-section" id="architecture">
        <div className="workflow-grid-bg" aria-hidden="true" />
        <div className="shell">
          <div className="section-heading centered-heading light-heading">
            <span className="eyebrow">CONTROLLED TASK LOOP</span>
            <h2>从意图到证据，五步完成闭环。</h2>
            <p>每个阶段都有明确输入与输出，失败可定位，结果可复核。</p>
          </div>
          <div className="workflow">
            {[
              ["01", "预检", "规则与风险评估"],
              ["02", "路由", "选择适配 Agent"],
              ["03", "执行", "受限工作区改动"],
              ["04", "验证", "白名单测试命令"],
              ["05", "报告", "证据与结论回传"],
            ].map((step, index) => (
              <div className="workflow-item" key={step[0]}>
                <span className="workflow-number">{step[0]}</span>
                <div className="workflow-icon">{index === 4 ? "✓" : ["⌁", "⇄", "›_", "◇"][index]}</div>
                <h3>{step[1]}</h3>
                <p>{step[2]}</p>
                {index < 4 && <span className="workflow-connector" aria-hidden="true">→</span>}
              </div>
            ))}
          </div>
          <div className="mode-grid">
            <article>
              <div className="mode-top"><span>CONTROL MODE A</span><i>适合复杂任务</i></div>
              <h3>chatgpt_delegate</h3>
              <p>ChatGPT 负责规划与验收，本地 Agent 负责仓库实现。职责分离，证据完整。</p>
              <div className="mode-route"><span>ChatGPT</span><b>→</b><span>PatchWarden</span><b>→</b><span>Agent</span></div>
            </article>
            <article>
              <div className="mode-top"><span>CONTROL MODE B</span><i>适合轻量改动</i></div>
              <h3>chatgpt_direct</h3>
              <p>在白名单和 Git 快照保护下直接读改仓库，缩短小任务执行链路。</p>
              <div className="mode-route"><span>ChatGPT</span><b>→</b><span>PatchWarden Direct</span></div>
            </article>
          </div>
        </div>
      </section>

      <section className="section evidence-section">
        <div className="shell evidence-layout">
          <div className="evidence-copy">
            <span className="eyebrow">AUDIT EVIDENCE</span>
            <h2>执行结束，不等于任务结束。</h2>
            <p>PatchWarden 为每次任务保留结构化产物，覆盖状态、结果、差异和验证，方便模型复核、人工审计与问题追踪。</p>
            <div className="evidence-note"><span>✓</span> 证据默认有界并对敏感信息脱敏</div>
          </div>
          <div className="evidence-panel">
            <div className="evidence-panel-head">
              <span>task/pw-0184/artifacts</span>
              <span className="verified-label">VERIFIED</span>
            </div>
            {evidence.map((item, index) => (
              <div className="evidence-row" key={item[0]}>
                <span className={`file-type file-type-${index}`}>{index === 2 ? "±" : "{}"}</span>
                <div><strong>{item[0]}</strong><small>{item[1]}</small></div>
                <span>{item[2]}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section install-section" id="install">
        <div className="shell">
          <div className="install-shell">
            <div className="install-copy">
              <span className="eyebrow">GET STARTED</span>
              <h2>选择你的安装方式。</h2>
              <p>先在本地建立安全执行边界，再把 Agent 接进来。</p>
              <div className="install-tabs" role="tablist" aria-label="安装方式">
                {(Object.keys(installOptions) as InstallKey[]).map((key) => (
                  <button
                    key={key}
                    className={installTab === key ? "active" : ""}
                    onClick={() => { setInstallTab(key); setCopied(false); }}
                    role="tab"
                    aria-selected={installTab === key}
                  >
                    {installOptions[key].label}
                  </button>
                ))}
              </div>
              <div className="install-summary">
                <strong>{currentInstall.eyebrow}</strong>
                <span>{currentInstall.description}</span>
              </div>
            </div>
            <div className="code-window">
              <div className="code-window-bar">
                <div className="window-dots"><i /><i /><i /></div>
                <span>{installTab === "windows" ? "PowerShell" : "Terminal"}</span>
                <button onClick={copyCommand} aria-label="复制安装命令">
                  {copied ? "已复制 ✓" : "复制命令"}
                </button>
              </div>
              <pre><code>{currentInstall.command}</code></pre>
            </div>
          </div>
        </div>
      </section>

      <section className="roadmap-section" id="roadmap">
        <div className="shell roadmap-layout">
          <div>
            <span className="eyebrow">ROADMAP</span>
            <h2>从可控执行，走向开放的安全 Agent 基础设施。</h2>
          </div>
          <div className="roadmap-list">
            <article className="complete">
              <span>01</span><div><small>已完成</small><h3>安全执行核心</h3><p>风险预检、Watcher、多 Agent 适配与审计证据。</p></div>
            </article>
            <article className="active">
              <span>02</span><div><small>持续完善</small><h3>体验与生态</h3><p>桌面控制中心、更多适配器与更清晰的任务报告。</p></div>
            </article>
            <article>
              <span>03</span><div><small>下一阶段</small><h3>协作与策略扩展</h3><p>团队策略、可复用模板与社区贡献者生态。</p></div>
            </article>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="cta-grid" aria-hidden="true" />
        <div className="shell final-cta-inner">
          <ShieldMark />
          <h2>把能力交给 Agent，<br />把边界留在自己手里。</h2>
          <p>PatchWarden 是开源项目。欢迎试用、提交 Issue，或接入新的编码 Agent。</p>
          <div className="hero-actions">
            <a className="button button-primary" href={githubUrl} target="_blank" rel="noreferrer">在 GitHub 上查看 <ArrowIcon /></a>
            <a className="button button-ghost" href="#install">查看安装方式</a>
          </div>
        </div>
      </section>

      <footer>
        <div className="shell footer-inner">
          <a className="brand" href="#top"><ShieldMark /><span>PatchWarden</span></a>
          <p>安全地连接模型与本地编码 Agent。</p>
          <div><span>MIT License</span><span>v{latestVersion}</span><a href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a></div>
        </div>
      </footer>
    </main>
  );
}
