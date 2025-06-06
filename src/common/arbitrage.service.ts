// src/common/arbitrage.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { StrategyHighService } from './strategy-high.service';
import { StrategyLowService } from './strategy-low.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { ExchangeService } from './exchange.service';
import { HighPremiumConditionData } from 'src/arbitrage/high-premium-processor.service';

@Injectable()
export class ArbitrageService {
  private readonly logger = new Logger(ArbitrageService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly strategyHighService: StrategyHighService,
    private readonly strategyLowService: StrategyLowService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly exchangeService: ExchangeService,
  ) {}

  async simulateArbitrage(
    data: HighPremiumConditionData,
    cycleId: string,
    actualInvestmentUSDT: number,
    onSimulationComplete?: () => Promise<void>,
  ) {
    const { symbol, upbitPrice, binancePrice, rate } = data;

    // [수정] 로그의 정확성을 위해 실제 투자금액으로 매수량 계산
    const buyAmount = actualInvestmentUSDT / binancePrice;
    await this.logSimulationStart(symbol, buyAmount, actualInvestmentUSDT);

    // --- 중요: StrategyHighService 호출하여 고프리미엄 매매 완료 및 DB 업데이트 시뮬레이션 ---
    this.logger.log(`[SIMULATE] 고프리미엄 매매 및 전송 시뮬레이션 시작...`);
    // 실제 API 호출 및 매매 로직은 여기에 들어갑니다.
    await this.strategyHighService.handleHighPremiumFlow(
      symbol,
      upbitPrice,
      binancePrice,
      rate,
      cycleId,
      actualInvestmentUSDT,
    );
    this.logger.log(
      `[SIMULATE] 고프리미엄 매매 및 전송 시뮬레이션 완료. DB 업데이트됨.`,
    );

    if (onSimulationComplete) {
      await onSimulationComplete();
    }
  }

  // [수정] 메소드 시그니처 및 로그 내용 변경
  private async logSimulationStart(
    symbol: string,
    buyAmount: number,
    investmentUSDT: number,
  ) {
    this.logger.log(
      `🚀 [SIMULATE] ${symbol.toUpperCase()} 차익거래 시뮬레이션 시작`,
    );
    this.logger.log(
      `- 투자금 및 매수량: $${investmentUSDT.toFixed(2)} → ${buyAmount.toFixed(4)} ${symbol.toUpperCase()}`,
    );
    // [삭제] 숏 포지션 관련 로그 삭제
  }
}
