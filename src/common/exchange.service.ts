import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class ExchangeService {
  private readonly logger = new Logger(ExchangeService.name);
  private currentRate = 1393; // fallback value
  private lastUpdated = 0;

  async onModuleInit() {
    await this.updateRate();
  }

  async updateRate() {
    try {
      const res = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=krw',
      );

      const rate = res.data?.tether?.krw;
      if (rate) {
        this.currentRate = rate;
        this.lastUpdated = Date.now();
        this.logger.log(`💱 [CoinGecko] 1 USDT ≈ ${rate} KRW`);
      }
    } catch (err) {
      this.logger.error(`❌ 환율 갱신 실패: ${err.message}`);
    }
  }

  getUSDTtoKRW(): number {
    return this.currentRate;
  }

  @Cron('*/1 * * * *') // 매 30초마다
  handleRateUpdate() {
    this.updateRate();
  }
}
