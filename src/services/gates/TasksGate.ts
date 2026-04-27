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
export const TasksGate: QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const tasksPath = path.join(meridianDir, "tracks", trackId, "tasks.md");

  if (!fs.exists(tasksPath)) {
    return Promise.resolve({
      success: false,
      gateName: "TasksGate",
      message: `tasks.md not found for track ${trackId}`,
    });
  }

  const content = fs.readFile(tasksPath);
  const taskRegex = /\[Task\s+\d+\.\d+\]/i;
  const dodRegex = /DoD/i;

  const validators: Record<string, { check: boolean; result: ValidationResult }> = {
    noTasks: {
      check: !taskRegex.test(content),
      result: {
        success: false,
        gateName: "TasksGate",
        message:
          "tasks.md must contain at least one task definition (e.g., [Task 1.1])",
      },
    },
    missingDoD: {
      check: !dodRegex.test(content),
      result: {
        success: false,
        gateName: "TasksGate",
        message: "Each task must have a Definition of Done (DoD) entry",
      },
    },
  };

  const failed = Object.values(validators).find(v => v.check);
  if (failed) {
    return Promise.resolve(failed.result);
  }

  return Promise.resolve({ success: true, gateName: "TasksGate" });
};
  }

  // Split content by tasks to check for DoD in each
  const taskHeaderRegex = /#+.*\[Task\s+\d+\.\d+\].*/i;
  const taskSections = content.split(taskHeaderRegex).slice(1);

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
