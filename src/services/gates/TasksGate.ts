import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

/**
 * Validates that a tasks.md file exists and contains at least one task entry
 * for a given track.
 * @param trackId - The identifier of the track to validate.
 * @param fs - The file system service interface for file operations.
 * @param meridianDir - The base directory path for Meridian tracks.
 * @returns A promise that resolves to a ValidationResult indicating success if
 * the tasks.md file exists and contains at least one task, or failure otherwise.
 */
export const TasksGate: QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const tasksPath = path.join(meridianDir, "tracks", trackId, "tasks.md");
  const exists = fs.exists(tasksPath);
  const content = exists ? fs.readFile(tasksPath) : "";
  const taskRegex = /\[Task\s+\d+\.\d+\]/i;
  const hasTasks = exists && taskRegex.test(content);

  const checks = {
    fileNotFound: !exists,
    noTasks: exists && !hasTasks,
  };
}

// Split content by tasks to check for DoD in each
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
