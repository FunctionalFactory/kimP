import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SpreadCalculatorService } from './spread-calculator.service';
import { ExchangeService } from './exchange.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { SlippageCalculatorService } from './slippage-calculator.service';
import { StrategyHighService } from './strategy-high.service';
import { StrategyLowService } from './strategy-low.service';
import { ArbitrageService } from './arbitrage.service';
import { TelegramService } from './telegram.service';
import { WithdrawalConstraintService } from './withdrawal-constraint.service';
import { MarketDataModule } from '../marketdata/marketdata.module';
import { UpbitModule } from '../upbit/upbit.module'; // ⭐️
import { BinanceModule } from '../binance/binance.module'; // ⭐️
import { ArbitrageModule } from '../arbitrage/arbitrage.module'; // ⭐️
import { ArbitrageRecordService } from '../db/arbitrage-record.service'; // ⭐️
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity'; // ⭐️

@Module({
  imports: [
    TypeOrmModule.forFeature([ArbitrageCycle]), // ⭐️ 추가
    MarketDataModule,
    UpbitModule,
    BinanceModule,
  ],
  providers: [
    SpreadCalculatorService,
    ExchangeService,
    FeeCalculatorService,
    SlippageCalculatorService,
    StrategyHighService,
    StrategyLowService,
    ArbitrageService,
    TelegramService,
    WithdrawalConstraintService,
    ArbitrageRecordService,
  ],
  exports: [
    SpreadCalculatorService,
    ExchangeService,
    FeeCalculatorService,
    SlippageCalculatorService,
    StrategyHighService,
    StrategyLowService,
    ArbitrageService,
    TelegramService,
    WithdrawalConstraintService,
    ArbitrageRecordService,
  ],
})
export class CommonModule {}
