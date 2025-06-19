// src/arbitrage/arbitrage.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArbitrageCycleStateService } from './arbitrage-cycle-state.service';
import { ArbitrageFlowManagerService } from './arbitrage-flow-manager.service';
import { HighPremiumProcessorService } from './high-premium-processor.service';
import { LowPremiumProcessorService } from './low-premium-processor.service';
import { CycleCompletionService } from './cycle-completion.service';

import { MarketDataModule } from '../marketdata/marketdata.module';
import { NotificationModule } from '../notification/notification.module';

import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { ArbitrageService } from '../common/arbitrage.service';
import { StrategyLowService } from '../common/strategy-low.service';
import { FeeCalculatorService } from '../common/fee-calculator.service';
import { ExchangeService } from '../common/exchange.service';

// ========================= [수정 부분 시작] =========================
import { UpbitModule } from '../upbit/upbit.module';
import { BinanceModule } from '../binance/binance.module';
// ========================== [수정 부분 끝] ==========================

import { PortfolioLogService } from '../db/portfolio-log.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { PortfolioLog } from '../db/entities/portfolio-log.entity';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';
import { StrategyHighService } from 'src/common/strategy-high.service';
import { DepositMonitorService } from './deposit-monitor.service';
import { SlippageCalculatorService } from 'src/common/slippage-calculator.service';

@Module({
  imports: [
    ConfigModule,
    MarketDataModule,
    NotificationModule,
    UpbitModule,
    BinanceModule,
    TypeOrmModule.forFeature([PortfolioLog, ArbitrageCycle]),
  ],
  providers: [
    ArbitrageCycleStateService,
    ArbitrageFlowManagerService,
    HighPremiumProcessorService,
    LowPremiumProcessorService,
    CycleCompletionService,
    DepositMonitorService,

    SpreadCalculatorService,
    PortfolioLogService,
    ArbitrageRecordService,
    ArbitrageService,
    StrategyHighService,
    StrategyLowService,
    FeeCalculatorService,
    ExchangeService,
    FeeCalculatorService,
    SlippageCalculatorService,
  ],
  exports: [
    ArbitrageFlowManagerService,
    ArbitrageCycleStateService,
    HighPremiumProcessorService,
    LowPremiumProcessorService,
    CycleCompletionService,
    ExchangeService,
    DepositMonitorService,
  ],
})
export class ArbitrageModule {}
