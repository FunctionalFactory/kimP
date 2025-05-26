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
import { ProfitCalculatorService } from '../common/profit-calculator.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { ArbitrageService } from '../common/arbitrage.service';
import { CycleProfitCalculatorService } from 'src/common/cycle-profit-calculator.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';

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
    { symbol: 'btt', upbit: 'KRW-BTT', binance: 'bttusdt' }, // 추가된 심볼
  ];

  private upbitPrices = new Map<string, number>();
  private binancePrices = new Map<string, number>();

  private readonly profitThresholdPercent = 0.7; // 진입 기준 (원하면 설정 가능)
  private readonly highThreshold = 0.7; // 프리미엄 상위 조건 (%)
  private readonly lowThreshold = -0.1; // 프리미엄 하위 조건 (%)

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly telegramService: TelegramService,
    private readonly strategyHighService: StrategyHighService,
    private readonly strategyLowService: StrategyLowService,
    private readonly profitCalculatorService: ProfitCalculatorService,
    private readonly arbitrageDetectorService: ArbitrageDetectorService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    private readonly arbitrageService: ArbitrageService,
    private readonly cycleProfitCalculatorService: CycleProfitCalculatorService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
  ) {}

  private isCycleInProgress = false; // 현재 차익거래 사이클 진행 여부 플래그

  onModuleInit() {
    for (const { symbol, upbit, binance } of this.watchedSymbols) {
      this.connectToUpbit(symbol, upbit);
      this.connectToBinance(symbol, binance);
    }
  }

  // handleHighPremiumFlow는 ArbitrageDetectorService의 콜백으로만 사용
  private handleHighPremiumFlow = async (symbol: string) => {
    // cycleId 인자 제거
    this.logger.log(
      `[DETECTOR] 고프리미엄 (${symbol.toUpperCase()}) 감지됨. triggerArbitrage 대기중.`,
    );
  };

  // handleLowPremiumFlow는 ArbitrageDetectorService의 콜백으로만 사용
  private handleLowPremiumFlow = async (symbol: string) => {
    // cycleId 인자 제거
    this.logger.log(
      `[DETECTOR] 저프리미엄 (${symbol.toUpperCase()}) 감지됨. 다음 플로우 진행 대기중.`,
    );
  };

  private evaluate = async () => {
    const rate = await this.exchangeService.getUSDTtoKRW();
    await this.arbitrageDetectorService.evaluateArbitrageTargets(
      this.watchedSymbols,
      this.upbitPrices,
      this.binancePrices,
      rate,
      this.highThreshold,
      this.lowThreshold,
      this.handleHighPremiumFlow,
      this.handleLowPremiumFlow,
      this.logger,
    );
  };

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  private async triggerArbitrage(data: {
    symbol: string;
    upbitPrice: number;
    binancePrice: number;
    rate: number;
    netProfit: number;
    netProfitPercent: number;
  }) {
    if (this.isCycleInProgress) {
      return;
    }

    const totalKRWCapital = 1_000_000;
    const rate = await this.exchangeService.getUSDTtoKRW();
    const initialInvestmentUSDT = totalKRWCapital / 2 / rate;

    const cycleProfitResult =
      await this.cycleProfitCalculatorService.calculateOverallCycleProfit(
        data.symbol,
        data.upbitPrice,
        data.binancePrice,
        initialInvestmentUSDT,
        this.watchedSymbols,
        this.upbitPrices,
        this.binancePrices,
      );

    if (cycleProfitResult.isProfitable) {
      this.isCycleInProgress = true;
      let currentCycleId: string | null = null;

      try {
        this.logger.warn(
          `✨ [CYCLE ARBITRAGE] 총 예상 수익률 ${cycleProfitResult.totalNetProfitPercent.toFixed(2)}% -> 차익거래 사이클 조건 만족!`,
        );

        // --- 1. 새로운 거래 사이클 시작 및 DB 저장 (고프리미엄 시작) ---
        const newCycle = await this.arbitrageRecordService.createArbitrageCycle(
          {
            startTime: new Date(),
            initialInvestmentUsd: initialInvestmentUSDT,
            initialInvestmentKrw: initialInvestmentUSDT * rate,
            highPremiumSymbol: data.symbol,
            highPremiumBinanceBuyPriceUsd: data.binancePrice,
            highPremiumInitialRate: data.rate, // data.rate는 triggerArbitrage의 인자로 전달된 값 사용
            highPremiumBuyAmount: initialInvestmentUSDT / data.binancePrice,
            highPremiumSpreadPercent:
              ((data.upbitPrice - data.binancePrice * data.rate) /
                (data.binancePrice * data.rate)) *
              100,
            highPremiumShortEntryFeeKrw: 0,
            status: 'IN_PROGRESS',
          },
        );
        currentCycleId = newCycle.id; // 생성된 사이클 ID 저장
        this.logger.log(
          `🚀 [SIMULATE] 새로운 차익거래 사이클 ${newCycle.id} 시작됨.`,
        );

        // --- 2. 고프리미엄 매매 시뮬레이션 및 DB 업데이트 (송금시간 30초 가정) ---
        this.logger.log(
          `➡️ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매수 및 송금 시작 (30초 대기)`,
        );
        await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

        await this.arbitrageService.simulateArbitrage(
          data,
          newCycle.id,
          initialInvestmentUSDT,
        );

        this.logger.log(
          `✅ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매매/송금 시뮬레이션 완료. DB 업데이트됨.`,
        );

        // --- 3. 저프리미엄 코인 탐색 및 매매 시뮬레이션 (현재 cycleId로 계속 진행) ---
        if (cycleProfitResult.recommendedLowPremiumSymbol) {
          const lowSymbol = cycleProfitResult.recommendedLowPremiumSymbol;
          const upbitPriceLow = this.upbitPrices.get(lowSymbol);
          const binancePriceLow = this.binancePrices.get(lowSymbol);

          if (upbitPriceLow && binancePriceLow) {
            this.logger.log(
              `⬅️ [SIMULATE] 저프리미엄 ${lowSymbol.toUpperCase()} 매수 및 송금 시작 (30초 대기)`,
            );
            const lowPremiumInvestmentKRW = totalKRWCapital / 2;

            await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

            await this.strategyLowService.handleLowPremiumFlow(
              lowSymbol,
              upbitPriceLow,
              binancePriceLow,
              rate,
              newCycle.id,
              lowPremiumInvestmentKRW,
            );
            this.logger.log(
              `✅ [SIMULATE] 저프리미엄 ${lowSymbol.toUpperCase()} 매매/송금 시뮬레이션 완료. DB 업데이트됨.`,
            );
          } else {
            this.logger.warn(
              `⚠️ [SIMULATE] 저프리미엄 ${lowSymbol.toUpperCase()} 가격 데이터 부족으로 시뮬레이션 건너뜀.`,
            );
            await this.arbitrageRecordService.updateArbitrageCycle(
              newCycle.id,
              {
                status: 'FAILED',
                errorDetails: `저프리미엄 ${lowSymbol.toUpperCase()} 가격 데이터 부족`,
                endTime: new Date(),
              },
            );
          }
        } else {
          this.logger.warn(
            `⚠️ [SIMULATE] 저프리미엄 코인 탐색 실패. 전체 플로우 완료되지 않음.`,
          );
          await this.arbitrageRecordService.updateArbitrageCycle(newCycle.id, {
            status: 'FAILED',
            errorDetails: '저프리미엄 코인 탐색 실패로 플로우 미완료',
            endTime: new Date(),
          });
        }

        if (currentCycleId) {
          const finalCycleStatusFromTry =
            await this.arbitrageRecordService.getArbitrageCycle(currentCycleId);

          if (finalCycleStatusFromTry) {
            const status = finalCycleStatusFromTry.status;
            const highSymbol =
              finalCycleStatusFromTry.highPremiumSymbol?.toUpperCase() || 'N/A';
            const lowSymbol =
              finalCycleStatusFromTry.lowPremiumSymbol?.toUpperCase() || 'N/A';

            const totalNetProfitPercentNumTry = this.parseAndValidateNumber(
              finalCycleStatusFromTry.totalNetProfitPercent,
            );
            const totalNetProfitKrwNumTry = this.parseAndValidateNumber(
              finalCycleStatusFromTry.totalNetProfitKrw,
            );
            const totalNetProfitUsdNumTry = this.parseAndValidateNumber(
              finalCycleStatusFromTry.totalNetProfitUsd,
            );
            const highPremiumNetProfitKrwNumTry = this.parseAndValidateNumber(
              finalCycleStatusFromTry.highPremiumNetProfitKrw,
            );
            const lowPremiumNetProfitKrwNumTry = this.parseAndValidateNumber(
              finalCycleStatusFromTry.lowPremiumNetProfitKrw,
            );

            if (status === 'COMPLETED') {
              await this.telegramService.sendMessage(
                `✅ *[시뮬레이션] 차익거래 사이클 ${currentCycleId} 완료! (try block)*` +
                  `총 수익률: ${totalNetProfitPercentNumTry !== null ? totalNetProfitPercentNumTry.toFixed(2) : 'N/A'}%` +
                  `총 순이익: ${totalNetProfitKrwNumTry !== null ? totalNetProfitKrwNumTry.toFixed(0) : 'N/A'}₩ (${totalNetProfitUsdNumTry !== null ? totalNetProfitUsdNumTry.toFixed(2) : 'N/A'}$)` +
                  `고프리미엄: ${highSymbol} (수익 ${highPremiumNetProfitKrwNumTry !== null ? highPremiumNetProfitKrwNumTry.toFixed(0) : 'N/A'}₩)` +
                  `저프리미엄: ${lowSymbol} (수익 ${lowPremiumNetProfitKrwNumTry !== null ? lowPremiumNetProfitKrwNumTry.toFixed(0) : 'N/A'}₩)`,
              );
            } else if (status === 'FAILED') {
              await this.telegramService.sendMessage(
                `❌ *[시뮬레이션] 차익거래 사이클 ${currentCycleId} 실패 (try block)* ` +
                  `사유: ${finalCycleStatusFromTry.errorDetails || '알 수 없는 오류'}`,
              );
            }
          }
        }
      } catch (error) {
        this.logger.error(
          `❌ [SIMULATE] 차익거래 사이클 ${currentCycleId || 'N/A'} 처리 중 오류 발생: ${error.message}`,
          error.stack,
        );
        if (currentCycleId) {
          try {
            await this.arbitrageRecordService.updateArbitrageCycle(
              currentCycleId,
              {
                status: 'FAILED',
                errorDetails: `사이클 처리 중 예외 발생: ${error.message}`,
                endTime: new Date(),
              },
            );
          } catch (dbError) {
            this.logger.error(
              `❌ [SIMULATE] DB 업데이트 중 오류 발생 (사이클 ${currentCycleId}): ${dbError.message}`,
            );
          }
        }
      } finally {
        this.isCycleInProgress = false;
        if (currentCycleId) {
          const finalCycleStatusFinally =
            await this.arbitrageRecordService.getArbitrageCycle(currentCycleId);

          if (finalCycleStatusFinally) {
            const status = finalCycleStatusFinally.status;
            const highSymbol =
              finalCycleStatusFinally.highPremiumSymbol?.toUpperCase() || 'N/A';
            const lowSymbol =
              finalCycleStatusFinally.lowPremiumSymbol?.toUpperCase() || 'N/A';

            // 숫자 변환 (parseAndValidateNumber 사용)
            const initialInvestmentKrwNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.initialInvestmentKrw,
            );
            const initialInvestmentUsdNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.initialInvestmentUsd,
            );

            const highPremiumNetProfitKrwNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumNetProfitKrw,
            );
            const highPremiumNetProfitUsdNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumNetProfitUsd,
            );
            // 고프리미엄 개별 수수료 (모두 parseAndValidateNumber 적용)
            const hpShortEntryFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumShortEntryFeeKrw,
            );
            const hpTransferFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumTransferFeeKrw,
            ); // 오류 발생 지점
            const hpSellFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumSellFeeKrw,
            );
            const hpShortExitFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.highPremiumShortExitFeeKrw,
            );

            const highPremiumTotalFeesKrw = // 안전하게 합산
              (hpShortEntryFeeKrw || 0) +
              (hpTransferFeeKrw || 0) +
              (hpSellFeeKrw || 0) +
              (hpShortExitFeeKrw || 0);

            const lowPremiumNetProfitKrwNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumNetProfitKrw,
            );
            const lowPremiumNetProfitUsdNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumNetProfitUsd,
            );
            // 저프리미엄 개별 수수료 (모두 parseAndValidateNumber 적용)
            const lpShortEntryFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumShortEntryFeeKrw,
            );
            const lpTransferFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumTransferFeeKrw,
            );
            const lpSellFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumSellFeeKrw,
            );
            const lpShortExitFeeKrw = this.parseAndValidateNumber(
              finalCycleStatusFinally.lowPremiumShortExitFeeKrw,
            );

            const lowPremiumTotalFeesKrw = // 안전하게 합산
              (lpShortEntryFeeKrw || 0) +
              (lpTransferFeeKrw || 0) +
              (lpSellFeeKrw || 0) +
              (lpShortExitFeeKrw || 0);

            const totalNetProfitPercentNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.totalNetProfitPercent,
            );
            const totalNetProfitKrwNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.totalNetProfitKrw,
            );
            const totalNetProfitUsdNum = this.parseAndValidateNumber(
              finalCycleStatusFinally.totalNetProfitUsd,
            );

            // --- 상세 요약 로그 추가 (수정된 부분) ---
            this.logger.log(
              `[ARBITRAGE_SUMMARY] Cycle ID: ${currentCycleId} - Status: ${status}`,
            );
            this.logger.log(
              `  Initial Investment: ${initialInvestmentKrwNum !== null ? initialInvestmentKrwNum.toFixed(0) : 'N/A'} KRW / ${initialInvestmentUsdNum !== null ? initialInvestmentUsdNum.toFixed(2) : 'N/A'} USD (per leg)`,
            );

            this.logger.log(`  --- High Premium Leg (${highSymbol}) ---`);
            this.logger.log(
              `    Net Profit: ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${highPremiumNetProfitUsdNum !== null ? highPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
            );
            this.logger.log(
              `    Estimated Total Fees: ${highPremiumTotalFeesKrw.toFixed(0)} KRW (Note: Needs full fee accounting from FeeCalculatorService)`,
            );
            this.logger.log(
              `      - Binance Buy (est.): Not directly in DB, from FeeCalculator`,
            );
            this.logger.log(
              `      - Transfer to Upbit: ${hpTransferFeeKrw !== null ? hpTransferFeeKrw.toFixed(0) : 'N/A'} KRW`,
            ); // 수정된 부분
            this.logger.log(
              `      - Upbit Sell: ${hpSellFeeKrw !== null ? hpSellFeeKrw.toFixed(0) : 'N/A'} KRW`,
            ); // 수정된 부분
            this.logger.log(
              `      - Futures (Entry+Exit, est.): ${(hpShortEntryFeeKrw || 0) + (hpShortExitFeeKrw || 0)} KRW`,
            ); // 수정된 부분

            this.logger.log(`  --- Low Premium Leg (${lowSymbol}) ---`);
            if (status === 'COMPLETED' && lowSymbol !== 'N/A') {
              this.logger.log(
                `    Net Profit: ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${lowPremiumNetProfitUsdNum !== null ? lowPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
              );
              this.logger.log(
                `    Estimated Total Fees: ${lowPremiumTotalFeesKrw.toFixed(0)} KRW (Note: Needs full fee accounting from FeeCalculatorService)`,
              );
              this.logger.log(
                `      - Upbit Buy: Not directly in DB, from FeeCalculator`,
              );
              this.logger.log(
                `      - Transfer to Binance: ${lpTransferFeeKrw !== null ? lpTransferFeeKrw.toFixed(0) : 'N/A'} KRW`,
              ); // 수정된 부분
              this.logger.log(
                `      - Binance Sell: ${lpSellFeeKrw !== null ? lpSellFeeKrw.toFixed(0) : 'N/A'} KRW`,
              ); // 수정된 부분
              this.logger.log(
                `      - Futures (Entry+Exit, est.): ${(lpShortEntryFeeKrw || 0) + (lpShortExitFeeKrw || 0)} KRW`,
              ); // 수정된 부분
            } else if (status !== 'FAILED') {
              this.logger.log(
                `    Low premium leg not completed or not applicable.`,
              );
            }

            this.logger.log(`  --- Overall Cycle Summary ---`);
            const overallTotalFees =
              highPremiumTotalFeesKrw + lowPremiumTotalFeesKrw;
            this.logger.log(
              `    Estimated Overall Total Fees: ${overallTotalFees.toFixed(0)} KRW`,
            );
            this.logger.log(
              `    Total Net Profit: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
            );
            this.logger.log(
              `    Total Net Profit Percent: ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%`,
            );

            // 텔레그램 메시지 전송 로직
            if (status === 'COMPLETED') {
              await this.telegramService.sendMessage(
                `✅ *[시뮬레이션] 차익거래 사이클 ${currentCycleId} 완료!*\n` +
                  `총 수익률: ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%\n` +
                  `총 순이익: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'}₩ (${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'}$)\n` +
                  `고프리미엄(${highSymbol}): ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
                  `저프리미엄(${lowSymbol}): ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩`,
              );
            } else if (status === 'FAILED') {
              await this.telegramService.sendMessage(
                `❌ *[시뮬레이션] 차익거래 사이클 ${currentCycleId} 실패*\n` +
                  `사유: ${finalCycleStatusFinally.errorDetails || '알 수 없는 오류'}`,
              );
            }
          }
        }
        this.logger.log(
          `🏁 [SIMULATE] 차익거래 사이클 ${currentCycleId || 'N/A'} 종료. 다음 기회 탐색 시작.`,
        );
      }
    } else {
      this.logger.log(
        `⚠️ [CYCLE ARBITRAGE] 총 예상 수익률 ${cycleProfitResult.totalNetProfitPercent.toFixed(2)}% -> 조건 불만족. (목표 ${this.cycleProfitCalculatorService.TARGET_CYCLE_PROFIT_PERCENT}%)`,
      );
    }
  }

  private trySpreadCalc = async (symbol: string) => {
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
    });
  };

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
