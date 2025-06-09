// src/arbitrage/deposit-monitor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ExchangeService, ExchangeType } from '../common/exchange.service';
import { TelegramService } from '../common/telegram.service';

// 비동기 지연을 위한 유틸리티 함수
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class DepositMonitorService {
  private readonly logger = new Logger(DepositMonitorService.name);

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly telegramService: TelegramService,
  ) {}

  /**
   * 특정 거래소와 코인에 대한 입금 모니터링을 시작합니다.
   * @param exchange 모니터링할 거래소 ('upbit' 또는 'binance')
   * @param symbol 모니터링할 코인 심볼 (예: 'XRP')
   * @param timeoutSeconds 타임아웃 시간 (초), 기본값 300초 (5분)
   */
  async monitorDeposit(
    exchange: ExchangeType,
    symbol: string,
    timeoutSeconds = 300,
  ) {
    this.logger.log(
      `[DepositMonitor] Starting to monitor ${symbol} deposit on ${exchange}...`,
    );
    await this.telegramService.sendMessage(
      `[입금 모니터링 시작] ${exchange.toUpperCase()}에서 ${symbol.toUpperCase()} 코인의 입금을 확인합니다. (최대 ${timeoutSeconds / 60}분)`,
    );

    const startTime = Date.now();
    const upperCaseSymbol = symbol.toUpperCase();

    try {
      // 1. 모니터링 시작 시점의 잔고 확인
      const initialBalances = await this.exchangeService.getBalances(exchange);
      const initialBalance =
        initialBalances.find((b) => b.currency === upperCaseSymbol)
          ?.available || 0;
      this.logger.log(
        ` > Initial available balance: ${initialBalance} ${upperCaseSymbol}`,
      );

      // 2. 타임아웃 시간까지 10초 간격으로 잔고 변화를 폴링
      while (Date.now() - startTime < timeoutSeconds * 1000) {
        await delay(10000); // 10초 대기

        const currentBalances =
          await this.exchangeService.getBalances(exchange);
        const currentBalance =
          currentBalances.find((b) => b.currency === upperCaseSymbol)
            ?.available || 0;

        this.logger.log(
          `[Polling] Current balance: ${currentBalance} ${upperCaseSymbol}`,
        );

        // 3. 잔고가 증가했으면 입금으로 간주하고 알림 후 종료
        if (currentBalance > initialBalance) {
          const depositedAmount = currentBalance - initialBalance;
          const message = `✅ [입금 완료] ${exchange.toUpperCase()}에 ${depositedAmount.toFixed(6)} ${upperCaseSymbol} 입금이 확인되었습니다!\n- 현재 잔고: ${currentBalance.toFixed(6)} ${upperCaseSymbol}`;

          this.logger.log(message);
          await this.telegramService.sendMessage(message);
          return { success: true, depositedAmount };
        }
      }

      // 4. 타임아웃 처리
      const timeoutMessage = `⚠️ [입금 모니터링 타임아웃] ${
        timeoutSeconds / 60
      }분 내에 ${exchange.toUpperCase()}의 ${symbol.toUpperCase()} 입금을 확인할 수 없었습니다.`;
      this.logger.warn(timeoutMessage);
      await this.telegramService.sendMessage(timeoutMessage);
      return { success: false, depositedAmount: 0 };
    } catch (error) {
      this.logger.error(
        `[DepositMonitor] Error during monitoring: ${error.message}`,
        error.stack,
      );
      await this.telegramService.sendMessage(
        `🚨 [입금 모니터링 오류] ${exchange.toUpperCase()}의 ${symbol.toUpperCase()} 입금 확인 중 오류가 발생했습니다.`,
      );
    }
  }
}
