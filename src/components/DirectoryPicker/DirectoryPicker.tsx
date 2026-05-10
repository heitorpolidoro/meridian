import React, { useState, useEffect } from 'react';
import './DirectoryPicker.css';

interface SocketLike {
  emit: (event: string, ...args: unknown[]) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
}

interface DirectoryPickerProps {
  socket: SocketLike;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function buildNavigationPath(currentPath: string, name: string): string {
  const separator = currentPath.includes('\\') ? '\\' : '/';
  return currentPath.endsWith(separator)
    ? `${currentPath}${name}`
    : `${currentPath}${separator}${name}`;
}

export const DirectoryPicker: React.FC<DirectoryPickerProps> = ({ socket, initialPath, onSelect, onClose }) => {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    socket.emit('list-dir-contents', currentPath);

    const handleContents = (contents: string[]) => {
      setEntries(contents);
      setLoading(false);
    };

    const handleParent = (parent: string) => {
      setCurrentPath(parent);
    };

    socket.on('dir-contents', handleContents);
    socket.on('parent-dir', handleParent);

    return () => {
      socket.off('dir-contents', handleContents);
      socket.off('parent-dir', handleParent);
    };
  }, [currentPath, socket]);

  const navigateTo = (name: string) => {
    setLoading(true);
    setCurrentPath(buildNavigationPath(currentPath, name));
  };

  const goUp = () => {
    setLoading(true);
    socket.emit('get-parent-dir', currentPath);
  };

  return (
    <div className="directory-picker-overlay">
      <div className="directory-picker-modal">
        <header>
          <h2>Select Directory</h2>
          <button type="button" className="close-btn" onClick={onClose}>&times;</button>
        </header>
        <div className="path-display">
          <code>{currentPath}</code>
        </div>
        <div className="picker-content">
          <div className="picker-actions">
            <button type="button" onClick={goUp} disabled={loading}>⬆️ Up</button>
          </div>
          <ul className="entry-list">
            {loading && <li className="loading">Loading...</li>}
            {!loading && entries.length === 0 && <li className="empty">No subdirectories found.</li>}
            {!loading && entries.length > 0 && entries.map(name => (
              <li 
                key={name} 
                onClick={() => navigateTo(name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigateTo(name);
                  if (e.key === ' ') navigateTo(name);
                }}
                role="button"
                tabIndex={0}
              >
                📁 {name}
              </li>
            ))}
          </ul>
        </div>
        <footer>
          <button type="button" className="cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="select-btn" onClick={() => onSelect(currentPath)}>Select Current</button>
        </footer>
      </div>
    </div>
  );
};
