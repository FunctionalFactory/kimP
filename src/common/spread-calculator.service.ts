// src/common/spread-calculator.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { HighPremiumConditionData } from '../arbitrage/high-premium-processor.service';
import { SlippageCalculatorService } from './slippage-calculator.service'; // ⭐️ Import 추가
import { ConfigService } from '@nestjs/config'; // ⭐️ ConfigService 추가

@Injectable()
export class SpreadCalculatorService {
  private readonly logger = new Logger(SpreadCalculatorService.name);
  private readonly MINIMUM_VOLUME_KRW: number;
  private readonly MIN_PROFIT_AFTER_SLIPPAGE: number;

  // ⭐️ SlippageCalculatorService 등 필요한 서비스들을 주입받습니다.
  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly slippageCalculatorService: SlippageCalculatorService,
    private readonly configService: ConfigService,
  ) {
    // ⭐️ 설정값을 constructor에서 초기화합니다.
    this.MINIMUM_VOLUME_KRW =
      this.configService.get<number>('MINIMUM_VOLUME_KRW') || 10000000000; // 100억
    this.MIN_PROFIT_AFTER_SLIPPAGE =
      this.configService.get<number>('MIN_PROFIT_AFTER_SLIPPAGE') || 0.2; // 슬리피지 고려 후 최소 수익률 0.2%
  }

  // ⭐️ 메소드 시그니처를 수정하여 실제 투자금을 받도록 합니다.
  async calculateSpread(params: {
    symbol: string;
    upbitPrice: number;
    binancePrice: number;
    investmentUSDT: number; // ⭐️ 실제 투자금을 받습니다.
  }): Promise<HighPremiumConditionData | null> {
    const { symbol, upbitPrice, binancePrice, investmentUSDT } = params;

    if (upbitPrice === undefined || binancePrice === undefined) {
      return null;
    }

    // --- 1단계: 기본 수익성 필터 ---
    const rate = this.exchangeService.getUSDTtoKRW();
    const buyAmount = investmentUSDT / binancePrice;
    if (buyAmount <= 0) return null;

    // ❗️ fee-calculator는 실제 계정 수수료를 받아야 더 정확합니다. 우선 기존 로직을 따릅니다.
    const feeResult = this.feeCalculatorService.calculate({
      symbol,
      amount: buyAmount,
      upbitPrice,
      binancePrice,
      rate,
      tradeDirection: 'HIGH_PREMIUM_SELL_UPBIT',
    });

    // 최소 진입 프리미엄 기준 (예: 1.5%)을 여기에 추가할 수 있습니다.
    const MINIMUM_ENTRY_PREMIUM = 1.1;
    if (feeResult.netProfitPercent < MINIMUM_ENTRY_PREMIUM) {
      this.logger.verbose(
        `[FILTER] ${symbol}: Initial profit ${feeResult.netProfitPercent.toFixed(2)}% is below entry threshold ${MINIMUM_ENTRY_PREMIUM}%.`,
      );

      return null;
    }

    this.logger.verbose(
      `[FILTER_PASS_1] ${symbol}: Initial profit ${feeResult.netProfitPercent.toFixed(2)}% OK.`,
    );

    // --- 2단계: 거래대금(유동성) 필터 ---
    try {
      const tickerInfo = await this.exchangeService.getTickerInfo(
        'upbit',
        symbol,
      );
      if (tickerInfo.quoteVolume < this.MINIMUM_VOLUME_KRW) {
        this.logger.verbose(
          `[FILTER_FAIL_2] ${symbol}: Volume ${(tickerInfo.quoteVolume / 100000000).toFixed(2)}억 is below threshold.`,
        );

        return null; // 거래량 미달 시 기회 아님
      }
    } catch (error) {
      this.logger.warn(
        `[FILTER] Ticker info check failed for ${symbol}: ${error.message}`,
      );
      return null;
    }

    // --- 3단계: 호가창(슬리피지) 정밀 필터 ---
    try {
      const orderBook = await this.exchangeService.getOrderBook(
        'binance',
        symbol,
      );
      const slippageResult = this.slippageCalculatorService.calculate(
        orderBook,
        'buy',
        investmentUSDT,
      );

      // 슬리피지를 차감한 최종 예상 수익률 계산
      const finalProfitPercent =
        feeResult.netProfitPercent - slippageResult.slippagePercent;

      if (finalProfitPercent < this.MIN_PROFIT_AFTER_SLIPPAGE) {
        this.logger.verbose(
          `[FILTER_FAIL_3] ${symbol}: Final profit ${finalProfitPercent.toFixed(2)}% (Slippage: ${slippageResult.slippagePercent.toFixed(2)}%) is below final threshold.`,
        );
        return null; // 슬리피지 고려 시 수익률 미달이면 기회 아님
      }

      this.logger.log(
        `[OPPORTUNITY FOUND] ${symbol.toUpperCase()}: Net profit ${finalProfitPercent.toFixed(2)}% (after slippage)`,
      );

      // --- 최종 통과: 검증된 기회 반환 ---
      return {
        symbol,
        upbitPrice,
        binancePrice,
        rate,
        netProfit: feeResult.netProfit, // 슬리피지 미반영 순수익
        netProfitPercent: finalProfitPercent, // 슬리피지 반영 최종 수익률
      };
    } catch (error) {
      this.logger.warn(
        `[FILTER] Slippage check failed for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }
}
