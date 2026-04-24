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
    const timestampElement = screen.getByText(
      (content) => content.startsWith("[") && content.endsWith("]"),
    );
    expect(timestampElement).toBeInTheDocument();
  });

  it("should handle null telemetry", () => {
    render(
      <TelemetryDashboard
        telemetry={null}
        compliance={mockCompliance}
        conflicts={[]}
      />,
    );

    expect(screen.getAllByText("0ms")).toHaveLength(2); // p95 and p50
    expect(screen.getByText("0")).toBeInTheDocument(); // total tokens
    expect(screen.getByText("0.0%")).toBeInTheDocument(); // error rate
  });

  it("should apply correct colors for different score ranges", () => {
    const multiCompliance = [
      {
        trackId: "high",
        score: 85,
        details: { hasSpec: true, hasPlan: true, hasTasks: true },
      },
      {
        trackId: "medium",
        score: 60,
        details: { hasSpec: true, hasPlan: true, hasTasks: true },
      },
      {
        trackId: "low",
        score: 30,
        details: { hasSpec: true, hasPlan: true, hasTasks: true },
      },
    ];

    const { container } = render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={multiCompliance}
        conflicts={[]}
      />,
    );

    const scoreFills = container.querySelectorAll(".score-fill");
    // High score (>80) should be #00ff88
    expect(scoreFills[0]).toHaveStyle("background-color: rgb(0, 255, 136)");
    // Medium score (>50) should be #ffcc00
    expect(scoreFills[1]).toHaveStyle("background-color: rgb(255, 204, 0)");
    // Low score (<=50) should be #ff4444
    expect(scoreFills[2]).toHaveStyle("background-color: rgb(255, 68, 68)");
  });

  it("should show invalid state for missing details", () => {
    const incompleteCompliance = [
      {
        trackId: "incomplete",
        score: 0,
        details: { hasSpec: false, hasPlan: false, hasTasks: false },
      },
    ];

    render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={incompleteCompliance}
        conflicts={[]}
      />,
    );

    expect(screen.getByText("Spec")).toHaveClass("invalid");
    expect(screen.getByText("Plan")).toHaveClass("invalid");
    expect(screen.getByText("Tasks")).toHaveClass("invalid");
  });
});
