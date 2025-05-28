// src/ws/ws.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import WebSocket from 'ws';

// 공통 모듈
import { ExchangeService } from '../common/exchange.service';
import { FeeCalculatorService } from '../common/fee-calculator.service';
import { TelegramService } from 'src/common/telegram.service';
import { ArbitrageDetectorService } from '../common/arbitrage-detector.service';
import { StrategyHighService } from '../common/strategy-high.service';
import { StrategyLowService } from '../common/strategy-low.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { ArbitrageService } from '../common/arbitrage.service';

// DB 관련 모듈
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ArbitrageCycle } from 'src/db/entities/arbitrage-cycle.entity'; // ArbitrageCycle 타입 사용

// 주석 모듈
// import { CycleProfitCalculatorService } from 'src/common/cycle-profit-calculator.service';
// import { ProfitCalculatorService } from '../common/profit-calculator.service';

// 차익거래 사이클 실행 상태 열거형
enum CycleExecutionStatus {
  IDLE, // 아무것도 진행 안 함
  HIGH_PREMIUM_PROCESSING, // 고프리미엄 거래 진행 중
  AWAITING_LOW_PREMIUM, // 고프리미엄 완료, 저프리미엄 탐색 대기
  LOW_PREMIUM_PROCESSING, // 저프리미엄 거래 진행 중
}

@Injectable()
export class WsService implements OnModuleInit {
  private readonly logger = new Logger(WsService.name);

  private readonly watchedSymbols = [
    { symbol: 'xrp', upbit: 'KRW-XRP', binance: 'xrpusdt' },
    { symbol: 'trx', upbit: 'KRW-TRX', binance: 'trxusdt' },
    { symbol: 'doge', upbit: 'KRW-DOGE', binance: 'dogeusdt' },
    { symbol: 'sol', upbit: 'KRW-SOL', binance: 'solusdt' },
    { symbol: 'matic', upbit: 'KRW-MATIC', binance: 'maticusdt' },
    { symbol: 'algo', upbit: 'KRW-ALGO', binance: 'algousdt' },
    { symbol: 'atom', upbit: 'KRW-ATOM', binance: 'atomusdt' },
    { symbol: 'eos', upbit: 'KRW-EOS', binance: 'eosusdt' },
    { symbol: 'xlm', upbit: 'KRW-XLM', binance: 'xlmusdt' },
    { symbol: 'ada', upbit: 'KRW-ADA', binance: 'adausdt' },
    { symbol: 'dot', upbit: 'KRW-DOT', binance: 'dotusdt' },
    { symbol: 'avax', upbit: 'KRW-AVAX', binance: 'avaxusdt' },
    { symbol: 'ftm', upbit: 'KRW-FTM', binance: 'ftmusdt' },
    { symbol: 'hbar', upbit: 'KRW-HBAR', binance: 'hbarusdt' },
    { symbol: 'zil', upbit: 'KRW-ZIL', binance: 'zilusdt' },
    { symbol: 'vet', upbit: 'KRW-VET', binance: 'vetusdt' },
    { symbol: 'icx', upbit: 'KRW-ICX', binance: 'icxusdt' },
    { symbol: 'qtum', upbit: 'KRW-QTUM', binance: 'qtumusdt' },
    { symbol: 'neo', upbit: 'KRW-NEO', binance: 'neousdt' },
    { symbol: 'btt', upbit: 'KRW-BTT', binance: 'bttcusdt' }, // 추가된 심볼
    { symbol: 'mana', upbit: 'KRW-MANA', binance: 'manausdt' }, // 추가된 심볼
    { symbol: 'grt', upbit: 'KRW-GRT', binance: 'grtusdt' }, // 추가된 심볼
    { symbol: 'lsk', upbit: 'KRW-LSK', binance: 'lskusdt' }, // 추가된 심볼
    { symbol: 'ardr', upbit: 'KRW-ARDR', binance: 'ardrusdt' }, // 추가된 심볼
  ];

  private upbitPrices = new Map<string, number>();
  private binancePrices = new Map<string, number>();

  private readonly profitThresholdPercent = 0.7; // 진입 기준 (원하면 설정 가능)
  private readonly TARGET_OVERALL_CYCLE_PROFIT_PERCENT = 0.1; // 전체 사이클 목표 수익률 (%) - 새로운 설정값
  private readonly LOW_PREMIUM_SEARCH_TIMEOUT_MS = 5 * 60 * 1000; // 예: 저프리미엄 탐색 타임아웃 5분
  private lowPremiumSearchStartTime: number | null = null;

  // private readonly highThreshold = 0.7; // 프리미엄 상위 조건 (%) ArbitrageDetectorService용
  // private readonly lowThreshold = -0.1; // 프리미엄 하위 조건 (%) ArbitrageDetectorService용

  // 차익거래 사이클 실행 상태 관리
  private currentCycleExecutionStatus: CycleExecutionStatus =
    CycleExecutionStatus.IDLE; //
  private activeCycleId: string | null = null; // 현재 진행 중인 사이클의 ID (고프리미엄 완료 후에도 유지)
  private requiredLowPremiumNetProfitKrwForActiveCycle: number | null = null; // 현재 사이클에서 필요한 저프리미엄 수익
  private highPremiumInitialRateForActiveCycle: number | null = null; // 현재 사이클의 고프리미엄 시작 시 환율
  // private isCycleInProgress = false; // currentCycleExecutionStatus로 대체

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly telegramService: TelegramService,
    private readonly strategyHighService: StrategyHighService,
    private readonly strategyLowService: StrategyLowService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    private readonly arbitrageService: ArbitrageService,
    private readonly arbitrageRecordService: ArbitrageRecordService,

    // 주석 모듈
    // private readonly arbitrageDetectorService: ArbitrageDetectorService,
    // private readonly profitCalculatorService: ProfitCalculatorService,
    // private readonly cycleProfitCalculatorService: CycleProfitCalculatorService,
  ) {}

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const num = Number(value);
    return isNaN(num) ? null : num;
  } //

  private isCycleInProgress = false; // 현재 차익거래 사이클 진행 여부 플래그

  onModuleInit() {
    for (const { symbol, upbit, binance } of this.watchedSymbols) {
      this.connectToUpbit(symbol, upbit);
      this.connectToBinance(symbol, binance);
    }
    // 저프리미엄 탐색 타임아웃을 위한 주기적인 검사 (선택적, 더 나은 방법은 상태 변경 시 타이머 설정)
    // setInterval(() => this.checkLowPremiumSearchTimeout(), 60 * 1000); // 1분마다 체크
  } //

  private async triggerArbitrage(data: {
    symbol: string; // 고프리미엄 대상 심볼
    upbitPrice: number; // 고프리미엄 대상 업비트 가격 (매도 예상가)
    binancePrice: number; // 고프리미엄 대상 바이낸스 가격 (매수 예상가)
    rate: number; // onArbitrageConditionMet 시점의 환율
    netProfit: number; // SpreadCalculatorService에서 계산한 고프리미엄 "단일 거래" 예상 순이익 (수수료 고려)
    netProfitPercent: number; // SpreadCalculatorService에서 계산한 고프리미엄 "단일 거래" 예상 순이익률
  }) {
    if (this.currentCycleExecutionStatus !== CycleExecutionStatus.IDLE) {
      this.logger.warn(
        `🟡 [SIMULATE] 다른 사이클이 진행 중이거나 대기 중입니다. 새로운 ${data.symbol.toUpperCase()} 감지 건은 건너뜁니다. (현재 상태: ${CycleExecutionStatus[this.currentCycleExecutionStatus]})`,
      );
      return;
    }

    this.currentCycleExecutionStatus =
      CycleExecutionStatus.HIGH_PREMIUM_PROCESSING;
    // this.isCycleInProgress = true; // isCycleInProgress를 사용한다면 여기서도 true로 설정

    this.logger.warn(
      `✨ [HIGH_PREMIUM_START] ${data.symbol.toUpperCase()} 고프리미엄 거래 조건 만족 (예상 수익률: ${data.netProfitPercent.toFixed(2)}%). 사이클 시작!`,
    );

    this.currentCycleExecutionStatus =
      CycleExecutionStatus.HIGH_PREMIUM_PROCESSING;
    const totalKRWCapital = 1_500_000;
    const highPremiumInitialRate = data.rate;
    const highPremiumInvestmentKRW = totalKRWCapital;
    const highPremiumInvestmentUSDT =
      highPremiumInvestmentKRW / highPremiumInitialRate;
    let tempCycleId: string | null = null;

    try {
      const newCycle = await this.arbitrageRecordService.createArbitrageCycle({
        startTime: new Date(),
        initialInvestmentKrw: highPremiumInvestmentKRW, // 단계별 투자금 기록
        initialInvestmentUsd: highPremiumInvestmentUSDT, // 단계별 투자금 기록
        highPremiumSymbol: data.symbol,
        highPremiumBinanceBuyPriceUsd: data.binancePrice,
        highPremiumInitialRate: highPremiumInitialRate,
        highPremiumBuyAmount:
          data.binancePrice !== 0
            ? highPremiumInvestmentUSDT / data.binancePrice
            : 0,
        highPremiumSpreadPercent:
          ((data.upbitPrice - data.binancePrice * highPremiumInitialRate) /
            (data.binancePrice * highPremiumInitialRate)) *
          100,
        status: 'IN_PROGRESS', // 초기 상태는 IN_PROGRESS
      });
      tempCycleId = newCycle.id;
      this.activeCycleId = tempCycleId;
      this.logger.log(
        `🚀 [SIMULATE] 새로운 차익거래 사이클 ${this.activeCycleId} DB 레코드 생성됨 (고프리미엄: ${data.symbol.toUpperCase()}).`,
      );

      const randomSeconds = Math.floor(Math.random() * (300 - 60 + 1)) + 60;
      const randomMinutes = (randomSeconds / 60).toFixed(1);
      this.logger.log(
        `➡️ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매수 및 송금 시작 (${randomMinutes}분 대기)`,
      );
      await new Promise((resolve) => setTimeout(resolve, randomSeconds * 1000));

      // ArbitrageService를 통해 StrategyHighService 호출 (실제 투자금 전달)
      // StrategyHighService.handleHighPremiumFlow는 내부에서 DB를 업데이트하고 'HIGH_PREMIUM_COMPLETED' 상태로 변경해야 함.
      // 또한, 실제 발생한 순이익(KRW)과 총 수수료(KRW)를 반환하도록 수정하면 좋음 (선택 사항)
      await this.arbitrageService.simulateArbitrage(
        {
          symbol: data.symbol,
          upbitPrice: data.upbitPrice,
          binancePrice: data.binancePrice,
          rate: highPremiumInitialRate,
        },
        this.activeCycleId,
        highPremiumInvestmentUSDT,
      );

      // StrategyHighService는 내부에서 status를 'HIGH_PREMIUM_COMPLETED'로 업데이트해야 함.
      // 또한, 실제 발생한 순이익(KRW)과 총 수수료(KRW)를 반환하도록 수정하면 좋음 (선택 사항)

      this.logger.log(
        `✅ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매매/송금 시뮬레이션 완료.`,
      );

      const highPremiumCompletedCycle =
        await this.arbitrageRecordService.getArbitrageCycle(this.activeCycleId);
      if (
        !highPremiumCompletedCycle ||
        highPremiumCompletedCycle.status !== 'HIGH_PREMIUM_COMPLETED'
      ) {
        throw new Error(
          `고프리미엄 단계 (${this.activeCycleId})가 DB에서 HIGH_PREMIUM_COMPLETED 상태로 확인되지 않았습니다. 현재 상태: ${highPremiumCompletedCycle?.status}`,
        );
      }

      const actualHighPremiumNetProfitKrw = this.parseAndValidateNumber(
        highPremiumCompletedCycle.highPremiumNetProfitKrw,
      );
      if (actualHighPremiumNetProfitKrw === null) {
        throw new Error(
          `고프리미엄 순이익(KRW)을 DB에서 가져올 수 없습니다 (사이클 ID: ${this.activeCycleId}).`,
        );
      }
      this.logger.log(
        `📈 [HIGH_PREMIUM_RESULT] ${data.symbol.toUpperCase()} 실제 순이익: ${actualHighPremiumNetProfitKrw.toFixed(0)} KRW`,
      );

      const overallTargetProfitKrw =
        (totalKRWCapital * this.TARGET_OVERALL_CYCLE_PROFIT_PERCENT) / 100;
      this.requiredLowPremiumNetProfitKrwForActiveCycle =
        overallTargetProfitKrw - actualHighPremiumNetProfitKrw;
      this.highPremiumInitialRateForActiveCycle = highPremiumInitialRate; // 저프리미엄 실패 시 totalNetProfitUsd 계산용

      this.logger.log(
        `🎯 [AWAITING_LOW_PREMIUM] 고프리미엄 완료. 저프리미엄 탐색 시작. (Cycle ID: ${this.activeCycleId}, 필요 최소 수익 KRW: ${this.requiredLowPremiumNetProfitKrwForActiveCycle.toFixed(0)})`,
      );
      this.currentCycleExecutionStatus =
        CycleExecutionStatus.AWAITING_LOW_PREMIUM;
      this.lowPremiumSearchStartTime = Date.now(); // 저프리미엄 탐색 시작 시간 기록
      // 저프리미엄 탐색은 이제 trySpreadCalc 또는 웹소켓 핸들러에서 주기적으로 findAndExecuteLowPremiumOpportunity를 호출하여 진행됨.
      // 첫 탐색을 위해 즉시 한 번 호출해줄 수 있음.
      await this.findAndExecuteLowPremiumOpportunity();
    } catch (error) {
      this.logger.error(
        `❌ [SIMULATE] triggerArbitrage (고프리미엄 단계) 처리 중 오류 (Cycle ID: ${this.activeCycleId || tempCycleId || 'N/A'}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (this.activeCycleId || tempCycleId) {
        await this.arbitrageRecordService.updateArbitrageCycle(
          this.activeCycleId || tempCycleId!,
          {
            status: 'FAILED',
            errorDetails: `고프리미엄 처리 중 예외: ${(error as Error).message}`,
            endTime: new Date(),
          },
        );
        await this.sendTelegramSummary(
          this.activeCycleId || tempCycleId!,
          await this.arbitrageRecordService.getArbitrageCycle(
            this.activeCycleId || tempCycleId!,
          ),
        );
      }
      this.resetCycleState();
    }
  }

  private async findAndExecuteLowPremiumOpportunity() {
    // --- 💘 가장 중요한 첫 번째 방어선: 현재 상태 확인 ---
    if (
      this.currentCycleExecutionStatus !==
        CycleExecutionStatus.AWAITING_LOW_PREMIUM ||
      !this.activeCycleId ||
      this.requiredLowPremiumNetProfitKrwForActiveCycle === null
    ) {
      this.logger.verbose(
        '[DEBUG] findAndExecuteLowPremiumOpportunity: Not in AWAITING_LOW_PREMIUM state or activeCycleId/requiredProfit is null. Skipping.',
      );
      return; // 이미 처리 중이거나, 탐색할 조건이 안되면 바로 종료
    }

    // 타임아웃 확인
    if (
      this.lowPremiumSearchStartTime &&
      Date.now() - this.lowPremiumSearchStartTime >
        this.LOW_PREMIUM_SEARCH_TIMEOUT_MS
    ) {
      this.logger.warn(
        `[LOW_PREMIUM_TIMEOUT] 저프리미엄 탐색 시간 초과 (Cycle ID: ${this.activeCycleId}). 목표 미달로 사이클 종료.`,
      );
      const highPremiumResult =
        await this.arbitrageRecordService.getArbitrageCycle(this.activeCycleId);
      const actualHighPremiumNetProfitKrw = this.parseAndValidateNumber(
        highPremiumResult?.highPremiumNetProfitKrw,
      );

      await this.arbitrageRecordService.updateArbitrageCycle(
        this.activeCycleId,
        {
          status: 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED',
          errorDetails: `저프리미엄 탐색 시간 초과 (필요 최소 수익 ${this.requiredLowPremiumNetProfitKrwForActiveCycle.toFixed(0)} KRW).`,
          endTime: new Date(),
          totalNetProfitKrw: actualHighPremiumNetProfitKrw,
          totalNetProfitUsd:
            actualHighPremiumNetProfitKrw !== null &&
            this.highPremiumInitialRateForActiveCycle !== null
              ? actualHighPremiumNetProfitKrw /
                this.highPremiumInitialRateForActiveCycle
              : null,
          totalNetProfitPercent:
            actualHighPremiumNetProfitKrw !== null
              ? (actualHighPremiumNetProfitKrw / (1_500_000 * 2)) * 100
              : null, // 전체 자본금 대비
        },
      );
      await this.sendTelegramSummary(
        this.activeCycleId,
        await this.arbitrageRecordService.getArbitrageCycle(this.activeCycleId),
      );
      this.resetCycleState();
      return;
    }

    this.logger.verbose(
      `[LOW_PREMIUM_SCAN_LOOP] 저프리미엄 기회 탐색 중... (Cycle ID: ${this.activeCycleId}, 필요 수익: ${this.requiredLowPremiumNetProfitKrwForActiveCycle.toFixed(0)})`,
    );

    let bestLowPremiumOpportunity: {
      symbol: string;
      upbitPrice: number;
      binancePrice: number;
      expectedNetProfitKrw: number;
      rate: number;
    } | null = null;

    const currentRateForLowPremium = await this.exchangeService.getUSDTtoKRW();
    const totalKRWCapital = 1_500_000;
    const lowPremiumInvestmentKRW = totalKRWCapital;

    const cycleInfo = await this.arbitrageRecordService.getArbitrageCycle(
      this.activeCycleId,
    );
    const highPremiumSymbolForCurrentCycle = cycleInfo?.highPremiumSymbol;

    for (const watched of this.watchedSymbols) {
      if (
        highPremiumSymbolForCurrentCycle &&
        watched.symbol === highPremiumSymbolForCurrentCycle
      ) {
        this.logger.verbose(
          `[LOW_PREMIUM_SCAN_LOOP] 고프리미엄에 사용된 코인(${watched.symbol})은 저프리미엄 대상에서 제외.`,
        );
        continue;
      }

      const upbitPrice = this.upbitPrices.get(watched.symbol);
      const binancePrice = this.binancePrices.get(watched.symbol);

      if (upbitPrice && binancePrice) {
        const amount = lowPremiumInvestmentKRW / upbitPrice;
        if (amount <= 0 || isNaN(amount)) continue; // 유효하지 않은 수량이면 건너뛰기

        const feeResult = this.feeCalculatorService.calculate({
          symbol: watched.symbol,
          amount: amount,
          upbitPrice: upbitPrice,
          binancePrice: binancePrice,
          rate: currentRateForLowPremium,
          tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
        });

        if (
          feeResult.netProfit >=
          this.requiredLowPremiumNetProfitKrwForActiveCycle
        ) {
          if (
            !bestLowPremiumOpportunity ||
            feeResult.netProfit > bestLowPremiumOpportunity.expectedNetProfitKrw
          ) {
            bestLowPremiumOpportunity = {
              symbol: watched.symbol,
              upbitPrice: upbitPrice,
              binancePrice: binancePrice,
              expectedNetProfitKrw: feeResult.netProfit,
              rate: currentRateForLowPremium,
            };
          }
        }
      }
    }
    if (bestLowPremiumOpportunity) {
      // --- 💘 상태 변경을 여기서 수행하여 중복 진입 방지 ---
      // AWAITING_LOW_PREMIUM 상태에서만 이 메소드가 유의미하게 실행되도록 하고,
      // 실제 거래를 시작하기로 결정하면 즉시 상태를 변경합니다.
      // 이 조건문은 한 번의 `findAndExecuteLowPremiumOpportunity` 실행 내에서
      // `bestLowPremiumOpportunity`를 찾았을 때, 다른 동시 실행이 상태를 바꾸지 않았는지
      // 다시 한번 확인하는 의미도 가질 수 있지만, 더 확실한 방법은
      // 이 메소드 자체의 진입을 제어하는 것입니다. (아래 trySpreadCalc에서 처리)
      // 여기서는 `bestLowPremiumOpportunity`를 찾으면 바로 상태를 변경합니다.

      // 현재 상태가 여전히 AWAITING_LOW_PREMIUM인지 다시 한번 확인 (매우 짧은 시간 내의 경쟁 상태 방어)
      if (
        this.currentCycleExecutionStatus !==
        CycleExecutionStatus.AWAITING_LOW_PREMIUM
      ) {
        this.logger.warn(
          `[LOW_PREMIUM_FOUND_BUT_SKIPPED] 상태가 이미 변경되어(${CycleExecutionStatus[this.currentCycleExecutionStatus]}) ${bestLowPremiumOpportunity.symbol.toUpperCase()} 저프리미엄 단계 진행 건너뜁니다. (Cycle ID: ${this.activeCycleId})`,
        );
        return;
      }

      // --- 상태를 LOW_PREMIUM_PROCESSING으로 즉시 변경! ---
      this.currentCycleExecutionStatus =
        CycleExecutionStatus.LOW_PREMIUM_PROCESSING;
      this.logger.log(
        `✅ [LOW_PREMIUM_FOUND] 최적 저프리미엄 코인 발견: ${bestLowPremiumOpportunity.symbol.toUpperCase()} (예상 수익: ${bestLowPremiumOpportunity.expectedNetProfitKrw.toFixed(0)} KRW). 저프리미엄 단계 진행.`,
      );

      try {
        const randomSeconds = Math.floor(Math.random() * (300 - 60 + 1)) + 60;
        const randomMinutes = (randomSeconds / 60).toFixed(1);
        this.logger.log(
          `⬅️ [SIMULATE] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 매수 및 송금 시작 (${randomMinutes}분 대기)`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, randomSeconds * 1000),
        );

        await this.strategyLowService.handleLowPremiumFlow(
          bestLowPremiumOpportunity.symbol,
          bestLowPremiumOpportunity.upbitPrice,
          bestLowPremiumOpportunity.binancePrice,
          bestLowPremiumOpportunity.rate,
          this.activeCycleId!, // activeCycleId가 null이 아님을 확신 (상태 체크로 보장)
          lowPremiumInvestmentKRW,
        );
        // StrategyLowService는 내부에서 status를 'COMPLETED'로 업데이트해야 함

        this.logger.log(
          `✅ [SIMULATE] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 매매/송금 시뮬레이션 완료.`,
        );

        const finalCycleStatus =
          await this.arbitrageRecordService.getArbitrageCycle(
            this.activeCycleId!,
          );
        if (!finalCycleStatus || finalCycleStatus.status !== 'COMPLETED') {
          throw new Error(
            `저프리미엄 단계 (${this.activeCycleId}) 후 사이클이 DB에서 COMPLETED 상태로 확인되지 않았습니다: ${finalCycleStatus?.status}`,
          );
        }
        await this.sendTelegramSummary(this.activeCycleId!, finalCycleStatus);
        this.resetCycleState();
      } catch (error) {
        this.logger.error(
          `❌ [LOW_PREMIUM_ERROR] 저프리미엄 처리 중 오류 (Cycle ID: ${this.activeCycleId}): ${(error as Error).message}`,
          (error as Error).stack,
        );
        if (this.activeCycleId) {
          // null 체크 추가
          await this.arbitrageRecordService.updateArbitrageCycle(
            this.activeCycleId,
            {
              status: 'FAILED',
              errorDetails: `저프리미엄 처리 중 오류: ${(error as Error).message}`,
              endTime: new Date(),
            },
          );
          const failedCycleStatus =
            await this.arbitrageRecordService.getArbitrageCycle(
              this.activeCycleId,
            );
          if (failedCycleStatus)
            await this.sendTelegramSummary(
              this.activeCycleId,
              failedCycleStatus,
            );
        }
        this.resetCycleState();
      }
    } else {
      this.logger.verbose(
        `[LOW_PREMIUM_SCAN_LOOP] 이번 주기에 적합한 저프리미엄 코인 없음. 계속 탐색. (Cycle ID: ${this.activeCycleId})`,
      );
    }
  }

  private resetCycleState() {
    this.logger.log(
      `🏁 [SIMULATE] 사이클 ${this.activeCycleId || 'N/A'} 관련 상태 초기화.`,
    );
    this.currentCycleExecutionStatus = CycleExecutionStatus.IDLE;
    this.activeCycleId = null;
    this.requiredLowPremiumNetProfitKrwForActiveCycle = null;
    this.highPremiumInitialRateForActiveCycle = null;
    this.lowPremiumSearchStartTime = null;
  } //

  private async sendTelegramSummary(
    cycleId: string,
    cycleData: ArbitrageCycle | null,
  ) {
    if (!cycleData) {
      this.logger.error(
        `[TELEGRAM_ERROR] Cycle data for ${cycleId} not found. Cannot send summary.`,
      );
      return;
    }

    const status = cycleData.status; //
    const highSymbol = cycleData.highPremiumSymbol?.toUpperCase() || 'N/A'; //
    const lowSymbol = cycleData.lowPremiumSymbol?.toUpperCase() || 'N/A'; //

    // 숫자 필드 파싱
    const initialInvestmentKrwNum = this.parseAndValidateNumber(
      cycleData.initialInvestmentKrw,
    ); //
    const initialInvestmentUsdNum = this.parseAndValidateNumber(
      cycleData.initialInvestmentUsd,
    ); //
    const highPremiumNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.highPremiumNetProfitKrw,
    ); //
    const highPremiumNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.highPremiumNetProfitUsd,
    );
    const lowPremiumNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.lowPremiumNetProfitKrw,
    ); //
    const lowPremiumNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.lowPremiumNetProfitUsd,
    );
    const totalNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitKrw,
    ); //
    const totalNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitUsd,
    ); //
    const totalNetProfitPercentNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitPercent,
    ); //

    // 고프리미엄 레그의 DB에 기록된 개별 수수료 합산
    const hpShortEntryFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumShortEntryFeeKrw,
    ); //
    const hpTransferFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumTransferFeeKrw,
    ); //
    const hpSellFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumSellFeeKrw,
    ); //
    const hpShortExitFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumShortExitFeeKrw,
    ); //
    const highPremiumRecordedFeesKrw =
      (hpShortEntryFeeKrw || 0) +
      (hpTransferFeeKrw || 0) +
      (hpSellFeeKrw || 0) +
      (hpShortExitFeeKrw || 0); //

    // 저프리미엄 레그의 DB에 기록된 개별 수수료 합산 (실행된 경우)
    let lowPremiumRecordedFeesKrw = 0;
    if (
      lowSymbol !== 'N/A' &&
      (status === 'COMPLETED' || cycleData.lowPremiumNetProfitKrw !== null)
    ) {
      const lpShortEntryFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumShortEntryFeeKrw,
      ); //
      const lpTransferFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumTransferFeeKrw,
      ); //
      const lpSellFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumSellFeeKrw,
      ); //
      const lpShortExitFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumShortExitFeeKrw,
      ); //
      lowPremiumRecordedFeesKrw =
        (lpShortEntryFeeKrw || 0) +
        (lpTransferFeeKrw || 0) +
        (lpSellFeeKrw || 0) +
        (lpShortExitFeeKrw || 0); //
    }

    // 텔레그램 메시지 생성 (기존 로직 유지)
    let telegramMessage = '';
    if (status === 'COMPLETED') {
      // ... (성공 메시지 생성)
      telegramMessage =
        `✅ *[시뮬레이션] 차익거래 사이클 ${cycleId} 완료!*\n` +
        `총 수익률: ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%\n` +
        `총 순이익: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'}₩ (${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'}$)\n` +
        `고프리미엄(${highSymbol}): ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
        `저프리미엄(${lowSymbol}): ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩`;
    } else if (
      status === 'FAILED' ||
      status === 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED'
    ) {
      // ... (실패 또는 부분 완료 메시지 생성)
      telegramMessage =
        `⚠️ *[시뮬레이션] 차익거래 사이클 ${cycleId} ${status === 'FAILED' ? '실패' : '부분 완료 (목표 미달)'}*\n` +
        `사유: ${cycleData.errorDetails || '알 수 없는 오류'}\n` +
        `고프리미엄(${highSymbol}) 순이익: ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
        (lowSymbol !== 'N/A' && lowPremiumNetProfitKrwNum !== null
          ? `저프리미엄(${lowSymbol}) 순이익: ${lowPremiumNetProfitKrwNum.toFixed(0)}₩\n`
          : '') +
        `최종 순이익: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'}₩ (${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%)`;
    } else {
      this.logger.warn(
        `[TELEGRAM_SKIP] Cycle ${cycleId} has status ${status}, no standard summary message sent.`,
      );
      // 상세 요약 로그만 출력하고 종료할 수도 있음
    }

    if (telegramMessage) {
      // 메시지가 생성된 경우에만 전송
      await this.telegramService.sendMessage(telegramMessage); //
    }

    // --- 상세 요약 로그 (ARBITRAGE_SUMMARY) ---
    this.logger.log(
      `[ARBITRAGE_SUMMARY] Cycle ID: ${cycleId} - Status: ${status}`,
    ); //
    // initialInvestmentKrw는 DB에 저장된 고프리미엄 단계 투자금.
    // 전체 사이클에 사용된 총 자본은 20,000,000 KRW.
    this.logger.log(
      `  Initial Investment (High-Premium Leg): ${initialInvestmentKrwNum !== null ? initialInvestmentKrwNum.toFixed(0) : 'N/A'} KRW / ${initialInvestmentUsdNum !== null ? initialInvestmentUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    this.logger.log(
      // 총 자본금 명시
      `  Total Capital Deployed for Cycle: ${(1_500_000).toFixed(0)} KRW`,
    );

    this.logger.log(`  --- High Premium Leg (${highSymbol}) ---`);
    this.logger.log(
      `    Net Profit: ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${highPremiumNetProfitUsdNum !== null ? highPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    this.logger.log(
      `    Recorded Individual Fees Sum: ${highPremiumRecordedFeesKrw.toFixed(0)} KRW (Note: This may not be the total actual fee from FeeCalculatorService)`,
    );
    this.logger.log(
      `      - Binance Spot Buy Fee (est.): Not in DB, from FeeCalculatorService`,
    );
    this.logger.log(
      `      - Transfer to Upbit Fee: ${hpTransferFeeKrw !== null ? hpTransferFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.log(
      `      - Upbit Spot Sell Fee: ${hpSellFeeKrw !== null ? hpSellFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.log(
      `      - Futures Entry Fee: ${hpShortEntryFeeKrw !== null ? hpShortEntryFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.log(
      `      - Futures Exit Fee: ${hpShortExitFeeKrw !== null ? hpShortExitFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    // this.logger.log(`      - USDT Transfer Fee (est.): Not in DB, from FeeCalculatorService`);

    if (
      lowSymbol !== 'N/A' &&
      (status === 'COMPLETED' || cycleData.lowPremiumNetProfitKrw !== null)
    ) {
      this.logger.log(`  --- Low Premium Leg (${lowSymbol}) ---`);
      this.logger.log(
        `    Net Profit: ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${lowPremiumNetProfitUsdNum !== null ? lowPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
      );
      this.logger.log(
        `    Recorded Individual Fees Sum: ${lowPremiumRecordedFeesKrw.toFixed(0)} KRW (Note: This may not be the total actual fee from FeeCalculatorService)`,
      );
      this.logger.log(
        `      - Upbit Spot Buy Fee (est.): Not in DB, from FeeCalculatorService`,
      );
      this.logger.log(
        `      - Transfer to Binance Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumTransferFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.log(
        `      - Binance Spot Sell Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumSellFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.log(
        `      - Futures Entry Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumShortEntryFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.log(
        `      - Futures Exit Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumShortExitFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
    } else if (
      status === 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED' ||
      (status === 'FAILED' && lowSymbol === 'N/A')
    ) {
      this.logger.log(`  --- Low Premium Leg ---`);
      this.logger.log(`    Not executed or failed before execution.`);
    }

    this.logger.log(`  --- Overall Cycle Summary ---`);
    const overallRecordedFeesSum =
      highPremiumRecordedFeesKrw + lowPremiumRecordedFeesKrw; // lowPremiumRecordedFeesKrw는 0일 수 있음
    this.logger.log(
      `    Sum of All Recorded Individual Fees: ${overallRecordedFeesSum.toFixed(0)} KRW (Note: May not be overall total actual fees from FeeCalculatorService for both legs)`,
    );
    this.logger.log(
      `    Total Net Profit (from DB): ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    this.logger.log(
      `    Total Net Profit Percent (from DB, based on ${cycleData.initialInvestmentKrw ? (this.parseAndValidateNumber(cycleData.initialInvestmentKrw)! * 2).toFixed(0) : 'N/A'} KRW or total capital): ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%`,
    );
  }

  private trySpreadCalc = async (symbol: string) => {
    if (this.currentCycleExecutionStatus === CycleExecutionStatus.IDLE) {
      const upbitPrice = this.upbitPrices.get(symbol);
      const binancePrice = this.binancePrices.get(symbol);

      if (upbitPrice === undefined || binancePrice === undefined) {
        return;
      }

      await this.spreadCalculatorService.calculateSpread({
        symbol,
        upbitPrice,
        binancePrice,
        profitThresholdPercent: this.profitThresholdPercent,
        onArbitrageConditionMet: this.triggerArbitrage.bind(this),
      }); //
    } else if (
      this.currentCycleExecutionStatus ===
      CycleExecutionStatus.AWAITING_LOW_PREMIUM
    ) {
      // 가격 변동이 있을 때마다 저프리미엄 탐색 시도
      // 너무 자주 호출되는 것을 방지하기 위해 Throttling/Debouncing 또는 마지막 호출 시간 기반 제어 추가 가능
      await this.findAndExecuteLowPremiumOpportunity();
    }
  }; //

  private connectToUpbit(symbol: string, market: string) {
    const socket = new WebSocket('wss://api.upbit.com/websocket/v1');

    socket.on('open', () => {
      this.logger.log(`🟢 [Upbit] Connected for ${market}`);
      const payload = [
        { ticket: `kimP-${symbol}` },
        { type: 'ticker', codes: [market] },
      ];
      socket.send(JSON.stringify(payload));
    });

    socket.on('message', (data) => {
      const json = JSON.parse(data.toString('utf8'));
      const price = json.trade_price;
      this.upbitPrices.set(symbol, price);
      this.trySpreadCalc(symbol);
    });

    socket.on('close', () => {
      this.logger.warn(`🔁 [Upbit] Reconnecting for ${market}...`);
      setTimeout(() => this.connectToUpbit(symbol, market), 1000);
    });

    socket.on('error', (err) => {
      this.logger.error(`🔥 [Upbit] ${market} WebSocket Error: ${err.message}`);
    });
  }

  private connectToBinance(symbol: string, stream: string) {
    const socket = new WebSocket(
      `wss://stream.binance.com:9443/ws/${stream}@ticker`,
    );

    socket.on('open', () => {
      this.logger.log(`🟢 [Binance] Connected for ${stream}`);
    });

    socket.on('message', (data) => {
      try {
        const raw = data.toString();
        const json = JSON.parse(raw);
        const price = parseFloat(json?.c);

        if (!price || isNaN(price)) {
          this.logger.warn(`⚠️ [Binance ${symbol}] price invalid:`, json);
          return;
        }

        this.binancePrices.set(symbol, price);
        this.trySpreadCalc(symbol);
      } catch (e) {
        this.logger.error(`❌ [Binance ${symbol}] message parse error: ${e}`);
      }
    });

    socket.on('close', () => {
      this.logger.warn(`🔁 [Binance] Reconnecting for ${stream}...`);
      setTimeout(() => this.connectToBinance(symbol, stream), 1000);
    });

    socket.on('error', (err) => {
      this.logger.error(
        `🔥 [Binance] ${stream} WebSocket Error: ${err.message}`,
      );
    });
  }
}
