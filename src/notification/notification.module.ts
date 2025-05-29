// src/notification/notification.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationComposerService } from '../notification/notification-composer.service';
import { TelegramService } from '../common/telegram.service'; // TelegramService가 common에 있다고 가정
// PortfolioLogService는 NotificationComposerService가 최신 잔고를 직접 조회할 경우 필요
import { PortfolioLogService } from '../db/portfolio-log.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PortfolioLog } from '../db/entities/portfolio-log.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([PortfolioLog]), // PortfolioLogService가 PortfolioLog Repository를 사용하기 위함
  ],
  providers: [
    NotificationComposerService,
    TelegramService, // NotificationComposerService가 TelegramService를 사용
    PortfolioLogService, // NotificationComposerService가 최신 잔고를 직접 조회할 경우
  ],
  exports: [NotificationComposerService, TelegramService],
})
export class NotificationModule {}
