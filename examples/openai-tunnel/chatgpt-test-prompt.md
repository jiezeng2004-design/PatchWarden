# PatchWarden ChatGPT Test Prompt

Paste this into a ChatGPT conversation where the PatchWarden Connector is
selected.

```text
Use the patchwarden connector tools to verify the workflow.

Step 1:
Call health_check and list_agents. Continue only if the watcher and selected
agent are available. Then call list_workspace for the configured workspace.
Confirm schema_epoch is 2026-06-20-v2, tool_profile is chatgpt_core, and
tool_count is 16. If the watcher is stale or missing, stop the task flow and
report the health_check recovery instruction.

Step 2:
Call read_workspace_file for README.md.

Step 3:
Call save_plan with:

title: Add Usage Section

content:
Add a "## Usage" section to the end of README.md. The section should include
one sentence: "This repository was updated through PatchWarden."
Do not modify other files. After the change, run the configured test command.

Step 4:
Call create_task with the returned plan_id, agent "opencode", an explicit
repo_path for the target repository, and verify_commands ["npm test"]. Set
timeout_seconds to 600.

Step 5:
Immediately call wait_for_task with timeout_seconds 25. If it returns
continuation_required: true, call wait_for_task again in this same assistant
turn. Do not stop or reply to the user until terminal is true.
If execution_blocked is true or next_tool_call is health_check, do not keep
polling; report the watcher recovery requirement.

Step 6:
When terminal is true, review the included summary, call get_task_summary and
audit_task, then call get_diff, get_test_log, and get_result_json as needed.

Step 7:
Summarize:
- final task status
- files changed
- whether tests passed
- whether any out-of-scope changes were detected
- acceptance_status and audit verdict
- whether the diff is acceptable
```
