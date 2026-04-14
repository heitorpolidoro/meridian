import { z } from 'zod';

export const SessionStatusSchema = z.enum(['Idle', 'Working', 'Error', 'Waiting_Approval']);

export const ActiveSessionSchema = z.object({
  trackId: z.string(),
  activeAgentId: z.string().optional(),
  currentTaskId: z.string().optional(),
  status: SessionStatusSchema.default('Idle'),
  startTime: z.string().optional(),
  lastActivity: z.string()
});

export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

export class SessionManagerService {
  // Key: trackId
  private sessions: Map<string, ActiveSession> = new Map();

  /**
   * Tracks an active assignment. 
   * Tells the system that an agent is now focused on a specific track/task.
   */
  assignAgent(trackId: string, agentId: string, taskId?: string): ActiveSession {
    const session: ActiveSession = {
      trackId,
      activeAgentId: agentId,
      currentTaskId: taskId,
      status: 'Working',
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };
    this.sessions.set(trackId, session);
    return session;
  }

  updateStatus(trackId: string, status: ActiveSession['status']): void {
    const session = this.sessions.get(trackId);
    if (session) {
      session.status = status;
      session.lastActivity = new Date().toISOString();
      this.sessions.set(trackId, session);
    }
  }

  releaseAgent(trackId: string): void {
    const session = this.sessions.get(trackId);
    if (session) {
      session.status = 'Idle';
      session.activeAgentId = undefined;
      session.currentTaskId = undefined;
      session.lastActivity = new Date().toISOString();
      this.sessions.set(trackId, session);
    }
  }

  getSession(trackId: string): ActiveSession | undefined {
    return this.sessions.get(trackId);
  }

  listActiveSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }
}
