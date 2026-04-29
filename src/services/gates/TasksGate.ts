import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import { TrackTasksSchema } from "../IPCSchemas";
import path from "node:path";
import YAML from "yaml";

/**
 * Validates the tasks file for a given track.
 * Requires a tasks.yaml file following the TrackTasksSchema.
 */
export const TasksGate: QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const yamlPath = path.join(meridianDir, "tracks", trackId, "tasks.yaml");

  if (!fs.exists(yamlPath)) {
    return Promise.resolve({
      success: false,
      gateName: "TasksGate",
      message: `tasks.yaml not found for track ${trackId}. Please migrate legacy tasks.md to tasks.yaml.`,
    });
  }

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
};
