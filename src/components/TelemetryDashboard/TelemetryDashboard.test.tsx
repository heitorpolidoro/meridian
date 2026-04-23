import React from "react";
import { render, screen } from "@testing-library/react";
import { TelemetryDashboard } from "./TelemetryDashboard";
import { SyncConflict } from "../../services/IPCSchemas";

describe("TelemetryDashboard", () => {
  const mockTelemetry = {
    p95Latency: 150,
    p50Latency: 80,
    totalTokens: 1000,
    errorRate: 0.05,
  };

  const mockCompliance = [
    {
      trackId: "track-1",
      score: 90,
      details: { hasSpec: true, hasPlan: true, hasTasks: true },
    },
  ];

  it("should not render conflicts section when list is empty", () => {
    render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={mockCompliance}
        conflicts={[]}
      />,
    );

    expect(screen.queryByText("Sync Alerts")).not.toBeInTheDocument();
  });

  it("should render conflicts section when there are items", () => {
    const mockConflicts: SyncConflict[] = [
      {
        timestamp: Date.now(),
        path: "src/app.ts",
        message: "Conflict detected",
        type: "error",
      },
    ];

    render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={mockCompliance}
        conflicts={mockConflicts}
      />,
    );

    expect(screen.getByText("Sync Alerts")).toBeInTheDocument();
    expect(screen.getByText("Conflict detected")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
  });

  it("should apply correct type class to conflict item", () => {
    const mockConflicts: SyncConflict[] = [
      {
        timestamp: Date.now(),
        path: "src/config.json",
        message: "Warning message",
        type: "warning",
      },
    ];

    const { container } = render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={mockCompliance}
        conflicts={mockConflicts}
      />,
    );

    const conflictItem = container.querySelector(".conflict-item");
    expect(conflictItem).toHaveClass("warning");
    expect(conflictItem).not.toHaveClass("error");
  });

  it("should format timestamp correctly", () => {
    const timestamp = new Date("2023-10-10T10:00:00Z").getTime();
    const mockConflicts: SyncConflict[] = [
      {
        timestamp,
        path: "file.ts",
        message: "Sync error",
        type: "error",
      },
    ];

    render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={mockCompliance}
        conflicts={mockConflicts}
      />,
    );

    // The exact format depends on the locale, but we check if the text starts with [ and ends with ]
    const timestampElement = screen.getByText((content) => 
      content.startsWith('[') && content.endsWith(']')
    );
    expect(timestampElement).toBeInTheDocument();
  });
});
