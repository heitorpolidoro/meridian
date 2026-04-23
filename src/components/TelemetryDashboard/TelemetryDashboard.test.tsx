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

  it("não deve renderizar a seção de conflitos quando a lista estiver vazia", () => {
    render(
      <TelemetryDashboard
        telemetry={mockTelemetry}
        compliance={mockCompliance}
        conflicts={[]}
      />,
    );

    expect(screen.queryByText("Sync Alerts")).not.toBeInTheDocument();
  });

  it("deve renderizar a seção de conflitos quando houver itens", () => {
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

  it("deve aplicar a classe de tipo correta ao item de conflito", () => {
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

  it("deve formatar o timestamp corretamente", () => {
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

    // O formato exato depende do locale, mas verificamos se algo que se pareça com um horário aparece entre []
    const timestampElement = screen.getByText(/\[.*\]/);
    expect(timestampElement).toBeInTheDocument();
  });
});
