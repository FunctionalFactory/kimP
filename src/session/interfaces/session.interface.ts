export interface ISession {
  id: string;
  status: SessionStatus;
  cycleId: string | null;
  highPremiumData: HighPremiumSessionData | null;
  lowPremiumData: LowPremiumSessionData | null;
  createdAt: Date;
  updatedAt: Date;
  priority: number;
}

export interface HighPremiumSessionData {
  symbol: string;
  investmentKRW: number;
  investmentUSDT: number;
  expectedProfit: number;
  executedAt: Date;
}

export interface LowPremiumSessionData {
  requiredProfit: number;
  allowedLoss: number;
  searchStartTime: Date;
  targetSymbol?: string;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  HIGH_PREMIUM_PROCESSING = 'HIGH_PREMIUM_PROCESSING',
  AWAITING_LOW_PREMIUM = 'AWAITING_LOW_PREMIUM',
  LOW_PREMIUM_PROCESSING = 'LOW_PREMIUM_PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
