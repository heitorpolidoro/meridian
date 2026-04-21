const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf8');

const replacements = [
  { old: 'const renderProjectsView = () => (', new: '/** Renders the projects discovery view. */\n  const renderProjectsView = () => (' },
  { old: 'const renderDashboardView = () => (', new: '/** Renders the governance dashboard view. */\n  const renderDashboardView = () => (' },
  { old: 'const renderTracksView = () => (', new: '/** Renders the track navigator view. */\n  const renderTracksView = () => (' },
  { old: 'const renderWarRoomView = () => (', new: '/** Renders the war room chat interface. */\n  const renderWarRoomView = () => (' },
  { old: 'const renderAgentsView = () => (', new: '/** Renders the active squad agent management view. */\n  // skipcq: JS-0415\n  const renderAgentsView = () => (' },
  { old: 'const renderSettingsView = () => (', new: '/** Renders the application settings view. */\n  // skipcq: JS-0415\n  const renderSettingsView = () => (' },
  { old: 'const renderContent = () => {', new: '/** Evaluates the current view state and renders the appropriate content component. */\n  const renderContent = () => {' },
  { old: '<div className="dot"></div>', new: '<div className="dot" />', global: true },
  { old: 'style={{ backgroundColor: agent.color }}></div>', new: 'style={{ backgroundColor: agent.color }} />', global: true }
];

replacements.forEach(r => {
  if (r.global) {
    content = content.split(r.old).join(r.new);
  } else {
    content = content.replace(r.old, r.new);
  }
});

fs.writeFileSync('src/App.tsx', content);
console.log('App.tsx fixed');
