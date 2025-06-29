import { Injectable, Logger } from '@nestjs/common';
import { ISession, SessionStatus } from './interfaces/session.interface';

@Injectable()
export class SessionPriorityService {
  private readonly logger = new Logger(SessionPriorityService.name);

  calculateSessionPriority(session: ISession): number {
    let priority = 0;

    // 1. 상태별 우선순위
    switch (session.status) {
      case SessionStatus.AWAITING_LOW_PREMIUM:
        priority += 1000; // 가장 높은 우선순위
        break;
      case SessionStatus.HIGH_PREMIUM_PROCESSING:
        priority += 500;
        break;
      case SessionStatus.IDLE:
        priority += 100;
        break;
    }

    // 2. 저프리미엄 세션의 경우 수익률 기반 우선순위
    if (
      session.status === SessionStatus.AWAITING_LOW_PREMIUM &&
      session.lowPremiumData
    ) {
      const profitRatio =
        session.lowPremiumData.requiredProfit /
        session.highPremiumData!.investmentKRW;
      priority += Math.floor(profitRatio * 10000); // 수익률이 높을수록 우선순위 증가
    }

    // 3. 대기시간 기반 우선순위 (최대 24시간)
    const waitTime = Date.now() - session.updatedAt.getTime();
    const maxWaitTime = 24 * 60 * 60 * 1000; // 24시간
    const timePriority = Math.min(waitTime / maxWaitTime, 1) * 100;
    priority += timePriority;

    return priority;
  }

  getNextSessionToProcess(sessions: ISession[]): ISession | null {
    if (sessions.length === 0) return null;

    const sessionsWithPriority = sessions.map((session) => ({
      session,
      priority: this.calculateSessionPriority(session),
    }));

    sessionsWithPriority.sort((a, b) => b.priority - a.priority);

    const nextSession = sessionsWithPriority[0];
    this.logger.log(
      `[PRIORITY] 다음 처리 세션: ${nextSession.session.id} (우선순위: ${nextSession.priority})`,
    );

    return nextSession.session;
  }
}
