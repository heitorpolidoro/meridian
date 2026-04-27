import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

/**
 * Validates that a tasks.md file exists, contains at least one task entry,
 * and that each task has a 'Definition of Done' (DoD).
 * @param trackId - The identifier of the track to validate.
 * @param fs - The file system service interface for file operations.
 * @param meridianDir - The base directory path for Meridian tracks.
 * @returns A promise that resolves to a ValidationResult indicating success if
 * the tasks.md file is valid, or failure otherwise.
 */
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
  const taskHeaderRegex = /#+.*\[Task\s+\d+\.\d+\].*/i;
  const taskSections = content.split(taskHeaderRegex).slice(1);
  const dodRegex =
    /#+\s*(?:Definition of Done|DoD)|(?:Definition of Done|DoD)\s*:/i;

  // Declarative checks
  const checks = [
    {
      condition: !/\[Task\s+\d+\.\d+\]/i.test(content),
      message:
        "tasks.md must contain at least one task definition (e.g., [Task 1.1])",
    },
  ];

  const initialFailure = checks.find((c) => c.condition);
  if (initialFailure) {
    return {
      success: false,
      gateName: "TasksGate",
      message: initialFailure.message,
    };
  }

  const invalidTasksCount = taskSections.filter(
    (section) => !dodRegex.test(section),
  ).length;

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
