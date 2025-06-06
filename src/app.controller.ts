// src/app.controller.ts
import { Controller, Get, Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { ExchangeService } from './common/exchange.service'; // ⭐️ ExchangeService import

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  // [수정] ExchangeService를 생성자에 주입
  constructor(
    private readonly appService: AppService,
    private readonly exchangeService: ExchangeService, // ⭐️ 주입
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // ========================= [테스트용 코드 추가] =========================
  @Get('/test-upbit-balance')
  async testUpbitBalance() {
    this.exchangeService.getUSDTtoKRW();
    this.logger.log('[/test-upbit-balance] Received test request.');
    try {
      // 'upbit'의 잔고 조회를 요청합니다.
      const balances = await this.exchangeService.getBalances('upbit');
      return {
        message: 'Successfully fetched Upbit balances.',
        data: balances,
      };
    } catch (error) {
      return {
        message: 'Failed to fetch Upbit balances.',
        error: error.message,
      };
    }
  }
  // =====================================================================
}
