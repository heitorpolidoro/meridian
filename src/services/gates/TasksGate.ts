import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import { TrackTasksSchema } from "../IPCSchemas";
import path from "node:path";
import YAML from "yaml";

/**
 * Validates the tasks file for a given track.
 * Supports both tasks.yaml (preferred) and legacy tasks.md.
 */
export const TasksGate: QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const yamlPath = path.join(meridianDir, "tracks", trackId, "tasks.yaml");
  const mdPath = path.join(meridianDir, "tracks", trackId, "tasks.md");

  // Prefer YAML
  if (fs.exists(yamlPath)) {
    try {
      const content = fs.readFile(yamlPath);
      const parsed = YAML.parse(content);
      const result = TrackTasksSchema.safeParse(parsed);

      if (!result.success) {
        return Promise.resolve({
          success: false,
          gateName: "TasksGate",
          message: "tasks.yaml has invalid schema",
          errors: result.error.errors.map(
            (e) => `${e.path.join(".")}: ${e.message}`,
          ),
        });
      }

      if (result.data.tasks.length === 0) {
        return Promise.resolve({
          success: false,
          gateName: "TasksGate",
          message: "tasks.yaml must contain at least one task",
        });
      }

      return Promise.resolve({
        success: true,
        gateName: "TasksGate",
        message: "tasks.yaml is valid",
      });
    } catch (error) {
      return Promise.resolve({
        success: false,
        gateName: "TasksGate",
        message: `Error parsing tasks.yaml: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Legacy Markdown support
  if (fs.exists(mdPath)) {
    const content = fs.readFile(mdPath);
    const hasTasks = /\[Task\s+\d+\.\d+\]/i.test(content);

    if (!hasTasks) {
      return Promise.resolve({
        success: false,
        gateName: "TasksGate",
        message: "Legacy tasks.md must contain at least one [Task X.X]",
      });
    }

    const taskHeaderRegex = /#+.*\[Task\s+\d+\.\d+\].*/i;
    const taskSections = content.split(taskHeaderRegex).slice(1);
    const dodRegex =
      /#+\s*(?:Definition of Done|DoD)|(?:Definition of Done|DoD)\s*:/i;

    const invalidTasksCount = taskSections.filter(
      (section) => !dodRegex.test(section),
    ).length;

    if (invalidTasksCount > 0) {
      return Promise.resolve({
        success: false,
        gateName: "TasksGate",
        message:
          "Legacy tasks.md: Each task must have a 'Definition of Done' (DoD)",
        errors: [`${invalidTasksCount} task(s) are missing DoD`],
      });
    }

    return Promise.resolve({
      success: true,
      gateName: "TasksGate",
      message: "Legacy tasks.md is valid (Consider migrating to tasks.yaml)",
    });
  }

  return Promise.resolve({
    success: false,
    gateName: "TasksGate",
    message: `Neither tasks.yaml nor tasks.md found for track ${trackId}`,
  });
};
