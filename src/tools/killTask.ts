import { requestTaskTermination } from "./cancelTask.js";

export function killTask(taskId: string) {
  return requestTaskTermination(taskId, true);
}
