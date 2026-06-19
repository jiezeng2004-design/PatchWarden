import { getTaskFile } from "./getTaskFile.js";

export function getTaskProgress(taskId: string) {
  return getTaskFile(taskId, "progress.md");
}
