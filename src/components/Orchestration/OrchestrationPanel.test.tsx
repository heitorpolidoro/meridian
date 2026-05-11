import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Socket } from "socket.io-client";
import { OrchestrationPanel } from "./OrchestrationPanel";

describe("OrchestrationPanel", () => {
  const mockSocket = { emit: vi.fn() } as unknown as Socket;

  const defaultMetadata = {
    orchestration: {
      currentPhase: "1.1" as const,
      status: "Idle",
      logs: [
        {
          timestamp: new Date().toISOString(),
          toPhase: "1.1" as const,
          status: "Started",
          message: "Process initialized",
        },
      ],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the current phase label", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    expect(screen.getByText("SDS Orchestration")).toBeInTheDocument();
    expect(screen.getByText("Spec")).toBeInTheDocument();
  });

  it("shows 'Approve Handoff' button only when status is HandoffReady", () => {
    const { rerender } = render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    expect(screen.queryByText("Approve Handoff")).not.toBeInTheDocument();

    const readyMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        status: "HandoffReady",
      },
    };

    rerender(
      <OrchestrationPanel
        trackId="test-track"
        metadata={readyMetadata}
        socket={mockSocket}
      />,
    );
    expect(screen.getByText("Approve Handoff")).toBeInTheDocument();
  });

  it("emits manual transition request when approving handoff", () => {
    const readyMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        status: "HandoffReady",
      },
    };

    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={readyMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Approve Handoff"));

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "orchestration:request-transition",
      {
        trackId: "test-track",
        targetPhase: "1.2",
        trigger: "Manual",
      },
    );
  });

  it("does not emit transition if already at the last phase when approving", () => {
    const lastPhaseMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        currentPhase: "5.0" as const,
        status: "HandoffReady",
      },
    };

    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={lastPhaseMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Approve Handoff"));

    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it("emits override transition request when clicking force override and confirming", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Force Override"));

    const input = screen.getByLabelText("Force override to phase:");
    fireEvent.change(input, { target: { value: "2.1" } });
    fireEvent.click(screen.getByText("Confirm"));

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "orchestration:request-transition",
      {
        trackId: "test-track",
        targetPhase: "2.1",
        trigger: "Override",
      },
    );
  });

  it("does not emit transition if override phase is invalid", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Force Override"));

    const input = screen.getByLabelText("Force override to phase:");
    fireEvent.change(input, { target: { value: "invalid-phase" } });
    fireEvent.click(screen.getByText("Confirm"));

    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it("does not emit transition if override is cancelled", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Force Override"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it("hides override dialog after cancel", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText("Force Override"));

    expect(
      screen.getByLabelText("Force override to phase:"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(
      screen.queryByLabelText("Force override to phase:"),
    ).not.toBeInTheDocument();
  });

  it("toggles logs visibility", () => {
    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={defaultMetadata}
        socket={mockSocket}
      />,
    );

    expect(screen.queryByText("Process initialized")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Orchestration Logs/));
    expect(screen.getByText("Process initialized")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Orchestration Logs/));
    expect(screen.queryByText("Process initialized")).not.toBeInTheDocument();
  });

  it("shows empty logs message when no logs are provided", () => {
    const emptyLogsMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        logs: [],
      },
    };

    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={emptyLogsMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText(/Orchestration Logs/));

    expect(screen.getByText("No logs recorded.")).toBeInTheDocument();
  });

  it("renders logs with fromPhase and uses status if message is missing", () => {
    const complexLogsMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        logs: [
          {
            timestamp: new Date().toISOString(),
            fromPhase: "1.1" as const,
            toPhase: "1.2" as const,
            status: "Completed",
          },
        ],
      },
    };

    render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={complexLogsMetadata}
        socket={mockSocket}
      />,
    );
    fireEvent.click(screen.getByText(/Orchestration Logs/));

    expect(screen.getByText("Spec → Plan")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("renders completed phases when current phase is advanced", () => {
    const advancedMetadata = {
      orchestration: {
        ...defaultMetadata.orchestration,
        currentPhase: "2.1" as const,
      },
    };

    const { container } = render(
      <OrchestrationPanel
        trackId="test-track"
        metadata={advancedMetadata}
        socket={mockSocket}
      />,
    );

    const completedPhases = container.querySelectorAll(".phase-item.completed");
    expect(completedPhases.length).toBe(2);
    expect(screen.getByText("Spec").parentElement).toHaveClass("completed");
    expect(screen.getByText("Plan").parentElement).toHaveClass("completed");
    expect(screen.getByText("Tasks").parentElement).toHaveClass("active");
  });
});
