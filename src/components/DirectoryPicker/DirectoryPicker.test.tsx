import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";

function getSocketHandler(
  mockSocket: { on: ReturnType<typeof vi.fn> },
  event: string,
): (...args: unknown[]) => void {
  const call = mockSocket.on.mock.calls.find((c: unknown[]) => c[0] === event);
  if (!call) throw new Error(`No socket handler registered for "${event}"`);
  return call[1] as (...args: unknown[]) => void;
}

describe("DirectoryPicker", () => {
  let mockSocket: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
  });

  it("renders with initial path and requests directory contents", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText("/initial/path")).toBeInTheDocument();
    expect(mockSocket.emit).toHaveBeenCalledWith("list-dir-contents", "/initial/path");
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("displays directories when loaded", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1", "folder2"]);
    });

    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("📁 folder1")).toBeInTheDocument();
    expect(screen.getByText("📁 folder2")).toBeInTheDocument();
  });

  it("displays empty message when no directories", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents([]);
    });

    expect(screen.getByText("No subdirectories found.")).toBeInTheDocument();
  });

  it("navigates to subdirectory when clicked (unix separator)", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1"]);
    });

    fireEvent.click(screen.getByText("📁 folder1"));

    expect(screen.getByText("/initial/path/folder1")).toBeInTheDocument();
    expect(mockSocket.emit).toHaveBeenCalledWith("list-dir-contents", "/initial/path/folder1");
  });


  it("navigates to subdirectory when clicked and ends with separator", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path/"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1"]);
    });

    fireEvent.click(screen.getByText("📁 folder1"));

    expect(screen.getByText("/initial/path/folder1")).toBeInTheDocument();
  });

  it("navigates to subdirectory when clicked and ends with separator (windows)", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath={"C:\\initial\\path\\"}
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1"]);
    });

    fireEvent.click(screen.getByText("📁 folder1"));

    expect(screen.getByText("C:\\initial\\path\\folder1")).toBeInTheDocument();
  });

  it("navigates to subdirectory when Enter or Space is pressed", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1"]);
    });

    const folder = screen.getByText("📁 folder1");
    
    // Test Enter
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(screen.getByText("/initial/path/folder1")).toBeInTheDocument();

    // Reset and test Space
    act(() => {
      onDirContents(["folder1", "folder2"]);
    });
    const folder2 = screen.getByText("📁 folder2");
    fireEvent.keyDown(folder2, { key: ' ' });
    expect(screen.getByText("/initial/path/folder1/folder2")).toBeInTheDocument();

    // Test other key (should not navigate)
    fireEvent.keyDown(folder2, { key: 'Escape' });
    expect(screen.getByText("/initial/path/folder1/folder2")).toBeInTheDocument();
  });

  it("navigates to subdirectory when clicked (windows separator)", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath={"C:\\initial\\path"}
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    
    act(() => {
      onDirContents(["folder1"]);
    });

    fireEvent.click(screen.getByText("📁 folder1"));

    expect(screen.getByText("C:\\initial\\path\\folder1")).toBeInTheDocument();
    expect(mockSocket.emit).toHaveBeenCalledWith("list-dir-contents", "C:\\initial\\path\\folder1");
  });

  it("goes up one directory", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path/folder"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    const onDirContents = getSocketHandler(mockSocket, "dir-contents");
    act(() => {
      onDirContents(["subfolder"]);
    });

    fireEvent.click(screen.getByText("⬆️ Up"));

    expect(mockSocket.emit).toHaveBeenCalledWith("get-parent-dir", "/initial/path/folder");

    const onParentDir = getSocketHandler(mockSocket, "parent-dir");
    
    act(() => {
      onParentDir("/initial/path");
    });

    expect(screen.getByText("/initial/path")).toBeInTheDocument();
    expect(mockSocket.emit).toHaveBeenCalledWith("list-dir-contents", "/initial/path");
  });

  it("calls onClose when close button is clicked", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when cancel button is clicked", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onSelect with current path when select button is clicked", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Current" }));
    expect(mockOnSelect).toHaveBeenCalledWith("/initial/path");
  });

  it("uses root fallback if no initial path is provided", () => {
    render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath=""
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText("/")).toBeInTheDocument();
  });
  
  it("cleans up socket event listeners on unmount", () => {
    const { unmount } = render(
      <DirectoryPicker
        socket={mockSocket}
        initialPath="/initial/path"
        onSelect={mockOnSelect}
        onClose={mockOnClose}
      />
    );

    unmount();

    expect(mockSocket.off).toHaveBeenCalledWith("dir-contents", expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith("parent-dir", expect.any(Function));
  });
});
