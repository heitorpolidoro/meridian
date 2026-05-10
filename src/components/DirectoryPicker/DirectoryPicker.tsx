import React, { useState, useEffect } from 'react';
import './DirectoryPicker.css';

interface DirectoryPickerProps {
  socket: any;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
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
    const separator = currentPath.includes('\\') ? '\\' : '/';
    const newPath = currentPath.endsWith(separator) ? `${currentPath}${name}` : `${currentPath}${separator}${name}`;
    setCurrentPath(newPath);
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
            {loading ? (
              <li className="loading">Loading...</li>
            ) : entries.length > 0 ? (
              entries.map(name => (
                <li key={name} onClick={() => navigateTo(name)}>
                  📁 {name}
                </li>
              ))
            ) : (
              <li className="empty">No subdirectories found.</li>
            )}
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
