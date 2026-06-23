# PatchWarden ChatGPT Test Prompt

Paste this into a ChatGPT conversation where the PatchWarden Connector is
selected.

```text
Use the patchwarden connector tools to verify the workflow.

Step 1:
Call health_check and list_agents. Continue only if the watcher and selected
agent are available. Then call list_workspace for the configured workspace.
Confirm schema_epoch is 2026-06-22-v6, tool_profile is chatgpt_core, and
tool_count is 16. If the watcher is stale or missing, stop the task flow and
report the health_check recovery instruction.

Step 2:
Call read_workspace_file for README.md.

Step 3:
Prefer the feature_small template for this bounded change. Use goal:
Add a "## Usage" section to the end of README.md. The section should include
one sentence: "This repository was updated through PatchWarden."
Do not modify other files. After the change, run the configured test command.

Step 4:
Call create_task with execution_mode "assess_only", template "feature_small",
the goal above, agent "opencode", an explicit repo_path, verify_commands
["npm test"], and timeout_seconds 600. If the decision is allow, invoke the
returned next_tool_call exactly as provided. Do not resend the goal, plan,
repository, agent, or verification arguments. If needs_confirm, stop and ask
the user to run the returned local patchwarden-confirm command. Never execute
a blocked assessment.

Step 5:
For this short task, call wait_for_task with timeout_seconds 25. If it returns
continuation_required: true, call it again in this same assistant turn. For a
long task, prefer list_tasks(repo_path=..., active_only=true) and
get_task_status instead of an extended wait loop.
If execution_blocked is true or next_tool_call is health_check, do not keep
polling; report the watcher recovery requirement.

Step 6:
When terminal is true, review the included compact summary, call
get_task_summary with view "compact", and call audit_task. Request the
standard summary, diff, test log, or result JSON only when compact evidence is
insufficient.

Step 7:
Summarize:
- final task status
- files changed
- whether tests passed
- whether any out-of-scope changes were detected
- acceptance_status and audit verdict
- confirmed_failures, possible_false_positives, and manual verification items
- whether the diff is acceptable
```
