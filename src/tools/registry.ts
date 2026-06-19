/**
 * Shared tool registry for Safe-Bifrost MCP server.
 * Used by both stdio (index.ts) and HTTP (httpServer.ts) transports.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../config.js";
import { savePlan } from "../tools/savePlan.js";
import { getPlan } from "../tools/getPlan.js";
import { createTask } from "../tools/createTask.js";
import { getTaskStatus } from "../tools/getTaskStatus.js";
import { getResult, getResultJson, getDiff, getTestLog } from "../tools/taskOutputs.js";
import { listWorkspace } from "../tools/listWorkspace.js";
import { readWorkspaceFile } from "../tools/readWorkspaceFile.js";
import { listTasks } from "../tools/listTasks.js";
import { cancelTask } from "../tools/cancelTask.js";
import { killTask } from "../tools/killTask.js";
import { retryTask } from "../tools/retryTask.js";
import { getTaskStdoutTail } from "../tools/getTaskStdoutTail.js";
import { getTaskProgress } from "../tools/getTaskProgress.js";
import { listAgents } from "../tools/listAgents.js";
import { healthCheck } from "../tools/healthCheck.js";
import { getTaskSummary } from "../tools/getTaskSummary.js";
import { waitForTask } from "../tools/waitForTask.js";
import { errorPayload } from "../errors.js";
import { auditTask } from "../tools/auditTask.js";
import { runTask } from "../runner/runTask.js";

// ── Tool definitions ──────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolDefs(): ToolDef[] {
  const config = getConfig();
  const agentNames = Object.keys(config.agents).sort();
  const agentDescription = agentNames.length > 0
    ? `Configured local agent name. Available agents: ${agentNames.map((name) => JSON.stringify(name)).join(", ")}`
    : "Configured local agent name. No agents are currently configured.";
  const testCommands = [...config.allowedTestCommands].sort();
  const tools: ToolDef[] = [
    {
      name: "save_plan",
      description:
        "Save an execution plan — ChatGPT writes the plan, Safe-Bifrost stores it for local agent execution.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Plan title" },
          content: { type: "string", description: "Plan content in Markdown" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "get_plan",
      description: "Read a saved plan by its plan_id.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: { type: "string", description: "Plan ID returned by save_plan" },
        },
        required: ["plan_id"],
      },
    },
    {
      name: "health_check",
      description:
        "Check MCP server uptime, watcher heartbeat freshness, and configured agent availability.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_agents",
      description:
        "List configured local agents and check whether each executable currently exists. This does not start an agent or contact its model provider.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "create_task",
      description:
        "Create a repo-scoped task. After success, immediately call wait_for_task repeatedly in the same assistant turn until terminal=true, then review get_task_summary/audit_task.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: { type: "string", description: "Plan ID from save_plan" },
          agent: {
            type: "string",
            description: agentDescription,
            ...(agentNames.length > 0 ? { enum: agentNames } : {}),
          },
          repo_path: {
            type: "string",
            description: "Required repository path inside workspaceRoot. No implicit workspace-root fallback is allowed.",
          },
          test_command: {
            type: "string",
            description: testCommands.length
              ? `Optional exact-match verification command. Allowed: ${testCommands.map((command) => JSON.stringify(command)).join(", ")}`
              : "Optional exact-match verification command. No commands are currently allowed.",
            ...(testCommands.length > 0 ? { enum: testCommands } : {}),
          },
          verify_commands: {
            type: "array",
            maxItems: 20,
            items: {
              type: "string",
              ...(testCommands.length > 0 ? { enum: testCommands } : {}),
            },
            description: "Recommended allow-listed commands Safe-Bifrost runs independently after the agent exits.",
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: config.maxTaskTimeoutSeconds,
            default: config.defaultTaskTimeoutSeconds,
            description: `Total task timeout in seconds (default ${config.defaultTaskTimeoutSeconds}, max ${config.maxTaskTimeoutSeconds})`,
          },
        },
        required: ["plan_id", "agent", "repo_path"],
      },
    },
    {
      name: "get_task_status",
      description: "Check task status, execution phase, heartbeat, current command, timeout, and change evidence.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from create_task" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_result",
      description: "Read the execution result (result.md) for a completed task.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_result_json",
      description: "Read the structured result.json for deterministic task acceptance.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_diff",
      description: "Read the git diff generated by a task execution.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_test_log",
      description: "Read the test log from a task execution.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "list_workspace",
      description:
        "List files and directories within the workspace (sensitive files excluded).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional relative path within workspace (default: root)",
          },
        },
      },
    },
    {
      name: "read_workspace_file",
      description:
        "Read a file within the workspace. Sensitive files (secrets, keys, tokens) are blocked.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to a file inside the workspace",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_tasks",
      description:
        "List recent tasks with optional status filter. Returns task_id, plan_id, title, agent, status, timestamps, repo_path, test_command, and error summary.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status: pending, running, done, failed, failed_verification, failed_scope_violation, canceled",
          },
          limit: {
            type: "number",
            description: "Max tasks to return (default 20, max 100)",
          },
        },
      },
    },
    {
      name: "cancel_task",
      description:
        "Request graceful cancellation. The runner that owns the child process performs termination; the MCP server never kills a PID read from task files.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to cancel" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "kill_task",
      description:
        "Request immediate termination of a pending or running task. The runner validates and kills only the child process it owns.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to terminate" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "retry_task",
      description:
        "Create a new task with the same plan, agent, repo_path, and test_command as an existing task. The original task is unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to retry" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_stdout_tail",
      description:
        "Read the last N lines of agent stdout/stderr. Reads from real-time stdout.log/stderr.log during execution, falls back to result.md after completion. Works on pending, running, and completed tasks. Default 80 lines.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          lines: { type: "number", description: "Tail line count (default 80, max 200)" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_progress",
      description:
        "Read progress.md for task phases and the most recent heartbeat/current command.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "wait_for_task",
      description:
        "Long-poll a task for up to 30 seconds. If continuation_required=true, call wait_for_task again immediately and do not finish the assistant turn. Terminal responses include get_task_summary acceptance evidence.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from create_task" },
          wait_seconds: { type: "integer", minimum: 1, maximum: 30, default: 25 },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_summary",
      description:
        "Return one structured acceptance summary: terminal status, scope violations, verification evidence, changed files, artifact availability, warnings, and errors.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "audit_task",
      description:
        "Independently audit a task's outputs. Verifies status, result.md, test.log, git.diff, repo_path consistency, cross-references agent claims with package.json scripts, and flags unverified release/publish claims. Writes independent-review.md to the task directory.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to audit" },
        },
        required: ["task_id"],
      },
    },
  ];

  // run_task: only available when explicitly enabled
  if ((config as any).enableRunTaskTool === true) {
    tools.push({
      name: "run_task",
      description:
        "Manually trigger execution of a pending task. WARNING: requires enableRunTaskTool=true in config. Prefer using the local watcher instead.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to execute" },
        },
        required: ["task_id"],
      },
    });
  }

  return tools;
}

// ── Request handler ───────────────────────────────────────────────

export async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "save_plan": {
      return toResult(
        savePlan({
          title: String(args?.title ?? ""),
          content: String(args?.content ?? ""),
        })
      );
    }

    case "get_plan": {
      return toResult(
        getPlan({ plan_id: String(args?.plan_id ?? "") })
      );
    }

    case "create_task": {
      return toResult(
        createTask({
          plan_id: String(args?.plan_id ?? ""),
          agent: String(args?.agent ?? ""),
          repo_path: args?.repo_path ? String(args.repo_path) : undefined,
          test_command: args?.test_command ? String(args.test_command) : undefined,
          verify_commands: Array.isArray(args?.verify_commands)
            ? args.verify_commands.map((command) => String(command))
            : undefined,
          timeout_seconds: args?.timeout_seconds !== undefined
            ? Number(args.timeout_seconds)
            : undefined,
        })
      );
    }

    case "get_task_status": {
      return toResult(getTaskStatus(String(args?.task_id ?? "")));
    }

    case "get_result": {
      return toResult(getResult(String(args?.task_id ?? "")));
    }

    case "get_result_json": {
      return toResult(getResultJson(String(args?.task_id ?? "")));
    }

    case "get_diff": {
      return toResult(getDiff(String(args?.task_id ?? "")));
    }

    case "get_test_log": {
      return toResult(getTestLog(String(args?.task_id ?? "")));
    }

    case "list_workspace": {
      return toResult(
        listWorkspace(args?.path ? String(args.path) : undefined)
      );
    }

    case "read_workspace_file": {
      return toResult(readWorkspaceFile(String(args?.path ?? "")));
    }

    case "list_tasks": {
      return toResult(listTasks({
        status: args?.status ? String(args.status) : undefined,
        limit: args?.limit ? Number(args.limit) : undefined,
      }));
    }

    case "list_agents": {
      return toResult(listAgents());
    }

    case "health_check": {
      return toResult(healthCheck());
    }

    case "cancel_task": {
      return toResult(cancelTask(String(args?.task_id ?? "")));
    }

    case "kill_task": {
      return toResult(killTask(String(args?.task_id ?? "")));
    }

    case "retry_task": {
      return toResult(retryTask(String(args?.task_id ?? "")));
    }

    case "get_task_stdout_tail": {
      return toResult(getTaskStdoutTail(
        String(args?.task_id ?? ""),
        args?.lines ? Number(args.lines) : undefined
      ));
    }

    case "get_task_progress": {
      return toResult(getTaskProgress(String(args?.task_id ?? "")));
    }

    case "wait_for_task": {
      return toResult(await waitForTask(
        String(args?.task_id ?? ""),
        args?.wait_seconds !== undefined ? Number(args.wait_seconds) : undefined
      ));
    }

    case "get_task_summary": {
      return toResult(getTaskSummary(String(args?.task_id ?? "")));
    }

    case "audit_task": {
      return toResult(auditTask(String(args?.task_id ?? "")));
    }

    case "run_task": {
      const config = getConfig();
      if ((config as any).enableRunTaskTool !== true) {
        throw new Error(
          "run_task is disabled. Set enableRunTaskTool: true in config to enable. Prefer using the local watcher (npm run watch)."
        );
      }
      const taskId = String(args?.task_id ?? "");
      const result = await runTask(taskId);
      return toResult(result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── Register on MCP Server ────────────────────────────────────────

export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefs() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, args);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errorPayload(err)) }],
        isError: true,
      };
    }
  });
}
