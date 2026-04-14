import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManagerService } from './SessionManagerService';

describe('SessionManagerService', () => {
  let sessionManager: SessionManagerService;

  beforeEach(() => {
    sessionManager = new SessionManagerService();
    // Mock Date.toISOString to have predictable timestamps
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assignAgent should create and return a new session', () => {
    const session = sessionManager.assignAgent('track-1', 'agent-1', 'task-1');
    
    expect(session).toEqual({
      trackId: 'track-1',
      activeAgentId: 'agent-1',
      currentTaskId: 'task-1',
      status: 'Working',
      startTime: '2023-01-01T00:00:00.000Z',
      lastActivity: '2023-01-01T00:00:00.000Z'
    });
    
    expect(sessionManager.getSession('track-1')).toBe(session);
  });

  it('updateStatus should update status and lastActivity', () => {
    sessionManager.assignAgent('track-1', 'agent-1');
    
    // Advance time
    vi.setSystemTime(new Date('2023-01-01T00:01:00Z'));
    
    sessionManager.updateStatus('track-1', 'Waiting_Approval');
    
    const session = sessionManager.getSession('track-1');
    expect(session?.status).toBe('Waiting_Approval');
    expect(session?.lastActivity).toBe('2023-01-01T00:01:00.000Z');
  });

  it('updateStatus should do nothing if track session does not exist', () => {
    sessionManager.updateStatus('non-existent', 'Working');
    expect(sessionManager.getSession('non-existent')).toBeUndefined();
  });

  it('releaseAgent should set status to Idle and clear agent/task', () => {
    sessionManager.assignAgent('track-1', 'agent-1', 'task-1');
    
    // Advance time
    vi.setSystemTime(new Date('2023-01-01T00:02:00Z'));
    
    sessionManager.releaseAgent('track-1');
    
    const session = sessionManager.getSession('track-1');
    expect(session?.status).toBe('Idle');
    expect(session?.activeAgentId).toBeUndefined();
    expect(session?.currentTaskId).toBeUndefined();
    expect(session?.lastActivity).toBe('2023-01-01T00:02:00.000Z');
  });

  it('releaseAgent should do nothing if track session does not exist', () => {
    sessionManager.releaseAgent('non-existent');
    expect(sessionManager.getSession('non-existent')).toBeUndefined();
  });

  it('getSession should return undefined for non-existent session', () => {
    expect(sessionManager.getSession('track-none')).toBeUndefined();
  });

  it('listActiveSessions should return all tracked sessions', () => {
    sessionManager.assignAgent('track-1', 'agent-1');
    sessionManager.assignAgent('track-2', 'agent-2');
    
    const sessions = sessionManager.listActiveSessions();
    expect(sessions.length).toBe(2);
    expect(sessions.find(s => s.trackId === 'track-1')).toBeDefined();
    expect(sessions.find(s => s.trackId === 'track-2')).toBeDefined();
  });
});
