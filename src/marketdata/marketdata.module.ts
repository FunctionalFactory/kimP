// src/marketdata/marketdata.module.ts
import { Module } from '@nestjs/common';
import { PriceFeedService } from './price-feed.service';
import { ConfigModule } from '@nestjs/config'; // ConfigService 사용 시 필요

@Module({
  imports: [ConfigModule], // ConfigService를 사용한다면 ConfigModule을 import
  providers: [PriceFeedService],
  exports: [PriceFeedService], // 다른 모듈에서 PriceFeedService를 사용할 수 있도록 export
})
export class MarketDataModule {}
