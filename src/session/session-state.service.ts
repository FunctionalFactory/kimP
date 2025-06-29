import { Injectable, Logger } from '@nestjs/common';
import { ISession, SessionStatus } from './interfaces/session.interface';

@Injectable()
export class SessionStateService {
  private readonly logger = new Logger(SessionStateService.name);
  private sessions: Map<string, ISession> = new Map();

  createSession(): ISession {
    const sessionId = this.generateSessionId();
    const session: ISession = {
      id: sessionId,
      status: SessionStatus.IDLE,
      cycleId: null,
      highPremiumData: null,
      lowPremiumData: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      priority: 0,
    };

    this.sessions.set(sessionId, session);
    this.logger.log(`[SESSION] 새 세션 생성: ${sessionId}`);
    return session;
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.updatedAt = new Date();
      this.logger.log(`[SESSION] ${sessionId} 상태 변경: ${status}`);
    }
  }

  updateSessionData(sessionId: string, data: Partial<ISession>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, data);
      session.updatedAt = new Date();
      this.logger.log(`[SESSION] ${sessionId} 데이터 업데이트`);
    }
  }

  getSession(sessionId: string): ISession | null {
    return this.sessions.get(sessionId) || null;
  }

  getActiveSessions(): ISession[] {
    return Array.from(this.sessions.values()).filter(
      (session) =>
        session.status !== SessionStatus.COMPLETED &&
        session.status !== SessionStatus.FAILED,
    );
  }

  getSessionsByStatus(status: SessionStatus): ISession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.status === status,
    );
  }

  getSessionsByCycleId(cycleId: string): ISession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.cycleId === cycleId,
    );
  }

  removeSession(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    if (removed) {
      this.logger.log(`[SESSION] 세션 제거: ${sessionId}`);
    }
    return removed;
  }

  getSessionStatistics(): {
    total: number;
    byStatus: Record<SessionStatus, number>;
  } {
    const sessions = Array.from(this.sessions.values());
    const byStatus: Record<SessionStatus, number> = {
      [SessionStatus.IDLE]: 0,
      [SessionStatus.HIGH_PREMIUM_PROCESSING]: 0,
      [SessionStatus.AWAITING_LOW_PREMIUM]: 0,
      [SessionStatus.LOW_PREMIUM_PROCESSING]: 0,
      [SessionStatus.COMPLETED]: 0,
      [SessionStatus.FAILED]: 0,
    };

    sessions.forEach((session) => {
      byStatus[session.status]++;
    });

    return {
      total: sessions.length,
      byStatus,
    };
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
