// src/ws/ws.module.ts
import { Module } from '@nestjs/common';
import { WsService } from './ws.service';
import { TypeOrmModule } from '@nestjs/typeorm';

// 엔티티
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';

// 서비스
import { ExchangeService } from '../common/exchange.service';
import { FeeCalculatorService } from '../common/fee-calculator.service';
import { TelegramService } from '../common/telegram.service';
import { StrategyHighService } from '../common/strategy-high.service';
import { StrategyLowService } from '../common/strategy-low.service';
import { ArbitrageDetectorService } from '../common/arbitrage-detector.service';
import { ProfitCalculatorService } from '../common/profit-calculator.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { ArbitrageService } from '../common/arbitrage.service';
import { CycleProfitCalculatorService } from '../common/cycle-profit-calculator.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';

@Module({
  imports: [TypeOrmModule.forFeature([ArbitrageCycle])],
  providers: [
    WsService,
    ExchangeService,
    FeeCalculatorService,
    TelegramService,
    CycleProfitCalculatorService,
    StrategyHighService,
    StrategyLowService,
    ArbitrageDetectorService,
    ProfitCalculatorService,
    SpreadCalculatorService,
    ArbitrageService,
    ArbitrageRecordService,
  ],
  exports: [WsService],
})
export class WsModule {}
