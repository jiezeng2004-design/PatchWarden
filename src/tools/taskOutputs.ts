import { getTaskFile, GetTaskFileOutput } from "./getTaskFile.js";

export function getResult(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "result.md");
}

export function getDiff(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "git.diff");
}

export function getTestLog(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "test.log");
}
