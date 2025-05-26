import { Injectable, Logger } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { StrategyHighService } from './strategy-high.service'; // 추가
import { StrategyLowService } from './strategy-low.service'; // 추가
import { FeeCalculatorService } from './fee-calculator.service'; // 추가 (필요 시)
import { ExchangeService } from './exchange.service'; // 추가 (필요 시)

interface ArbitrageSimulationData {
  symbol: string;
  upbitPrice: number;
  binancePrice: number;
  rate: number;
  netProfit: number;
  netProfitPercent: number;
}

@Injectable()
export class ArbitrageService {
  private readonly logger = new Logger(ArbitrageService.name);
  private readonly totalUSDT = 1500; // 시뮬레이션 기준 금액 (여기서는 WsService에서 재정의된 2000만원 기준의 USDT로 대체됨)

  constructor(
    private readonly telegramService: TelegramService,
    private readonly strategyHighService: StrategyHighService, // 주입
    private readonly strategyLowService: StrategyLowService, // 주입
    private readonly feeCalculatorService: FeeCalculatorService, // 주입
    private readonly exchangeService: ExchangeService, // 주입
  ) {}

  async simulateArbitrage(
    data: ArbitrageSimulationData,
    cycleId: string, // <-- cycleId 인자 추가
    actualInvestmentUSDT: number, // WsService로부터 받을 실제 투자금 (USD)
    onSimulationComplete?: () => Promise<void>,
  ) {
    const {
      symbol,
      upbitPrice,
      binancePrice,
      rate,
      // netProfit,
      // netProfitPercent,
    } = data;

    // 이 totalUSDT는 WsService에서 넘어오는 초기 자본금을 의미하므로, 여기서는 사용하지 않거나,
    // 실제 매매 시에는 WsService에서 넘어온 initialInvestmentUSDT를 활용해야 합니다.
    // 여기서는 WsService에서 설정된 금액을 사용하므로, halfUSDT 계산은 무의미합니다.
    // buyAmount 계산도 WsService에서 이미 되었으므로 여기서는 로그에만 사용합니다.
    // const halfUSDT = this.totalUSDT / 2;
    // const buyAmount = halfUSDT / binancePrice;
    // await this.logSimulationStart(symbol, buyAmount, halfUSDT);
    // await this.notifyTelegram(data, buyAmount, halfUSDT);

    const buyAmount = this.totalUSDT / 2 / binancePrice; // 기존 시뮬레이션 로깅을 위해 유지
    await this.logSimulationStart(symbol, buyAmount, this.totalUSDT / 2); // totalUSDT/2는 시뮬레이션 로깅 목적
    // await this.notifyTelegram(data, buyAmount, this.totalUSDT / 2);

    // --- 중요: StrategyHighService 호출하여 고프리미엄 매매 완료 및 DB 업데이트 시뮬레이션 ---
    this.logger.log(`[SIMULATE] 고프리미엄 매매 및 전송 시뮬레이션 시작...`);
    // 실제 API 호출 및 매매 로직은 여기에 들어갑니다.
    await this.strategyHighService.handleHighPremiumFlow(
      symbol,
      upbitPrice,
      binancePrice,
      rate,
      cycleId, // <-- cycleId 전달
      actualInvestmentUSDT, // 실제 투자금 전달
    );
    this.logger.log(
      `[SIMULATE] 고프리미엄 매매 및 전송 시뮬레이션 완료. DB 업데이트됨.`,
    );

    // --- 다음 저프리미엄 단계로의 연계 (예시) ---
    // 실제 구현에서는 입금 확인 등의 비동기적인 과정이 필요합니다.
    // 여기서는 시뮬레이션이므로 즉시 다음 단계(저프리미엄 탐색 및 시뮬레이션)를 트리거할 수 있습니다.
    // 다만, `WsService`의 `evaluate` 함수는 모든 심볼을 주기적으로 탐색하므로,
    // 여기서 직접 `handleLowPremiumFlow`를 호출하기보다는,
    // DB의 `status: 'HIGH_PREMIUM_COMPLETED'`를 보고 `WsService`의 다른 로직이 저프리미엄을 탐색하도록 하는 것이 좋습니다.

    if (onSimulationComplete) {
      await onSimulationComplete();
    }
  }

  private async logSimulationStart(
    symbol: string,
    buyAmount: number,
    halfUSDT: number,
  ) {
    this.logger.log(
      `🚀 [SIMULATE] ${symbol.toUpperCase()} 차익거래 시뮬레이션 시작`,
    );
    this.logger.log(`- 총 자본: $${this.totalUSDT}`);
    this.logger.log(
      `- 매수 후 전송: $${halfUSDT} → ${buyAmount.toFixed(4)} ${symbol.toUpperCase()}`,
    );
    this.logger.log(`- 숏 포지션 진입: $${halfUSDT} (청산은 전송 완료 후)`);
  }
}
