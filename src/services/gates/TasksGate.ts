import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

export const TasksGate: QualityGateFn = async (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const tasksPath = path.join(meridianDir, "tracks", trackId, "tasks.md");

  if (!fs.exists(tasksPath)) {
    return {
      success: false,
      gateName: "TasksGate",
      message: `tasks.md not found for track ${trackId}`,
    };
  }

  const content = fs.readFile(tasksPath);

  // Basic check for at least one task (e.g., [Task 1.1])
  const taskRegex = /\[Task\s+\d+\.\d+\]/i;
  const hasTasks = taskRegex.test(content);

  if (!hasTasks) {
    return {
      success: false,
      gateName: "TasksGate",
      message:
        "tasks.md must contain at least one task definition (e.g., [Task 1.1])",
    };
  }

  // Split content by tasks to check for DoD in each
  const taskHeaderRegex = /#+.*\[Task\s+\d+\.\d+\].*/i;

  // Using a simpler split and manual check
  const taskSections = content.split(/#+.*\[Task\s+\d+\.\d+\].*/i).slice(1);

  const dodRegex =
    /#+\s*(?:Definition of Done|DoD)|(?:Definition of Done|DoD)\s*:/i;
  let invalidTasksCount = 0;

  for (const section of taskSections) {
    if (!dodRegex.test(section)) {
      invalidTasksCount++;
    }
  }

  if (invalidTasksCount > 0) {
    return {
      success: false,
      gateName: "TasksGate",
      message: "Each task in tasks.md must have a 'Definition of Done' (DoD)",
      errors: [`${invalidTasksCount} task(s) are missing DoD`],
    };
  }

  return {
    success: true,
    gateName: "TasksGate",
    message: "tasks.md is valid",
  };
};
