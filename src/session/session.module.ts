import { Module } from '@nestjs/common';
import { SessionManagerService } from './session-manager.service';
import { SessionStateService } from './session-state.service';
import { SessionPriorityService } from './session-priority.service';
import { SessionExecutorService } from './session-executor.service';
import { ArbitrageModule } from '../arbitrage/arbitrage.module';
import { MarketDataModule } from '../marketdata/marketdata.module';
import { CommonModule } from '../common/common.module'; // ⭐️ 추가

@Module({
  imports: [ArbitrageModule, MarketDataModule, CommonModule],
  providers: [
    SessionManagerService,
    SessionStateService,
    SessionPriorityService,
    SessionExecutorService,
  ],
  exports: [SessionManagerService],
})
export class SessionModule {}
