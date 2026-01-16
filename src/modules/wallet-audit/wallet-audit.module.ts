import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletAudit } from '@vector-games/game-core';
import { WalletAuditService } from './wallet-audit.service';
import { WalletAuditCleanupService } from './wallet-audit-cleanup.service';
import { WalletRetryModule } from '../wallet-retry/wallet-retry.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WalletAudit]),
    forwardRef(() => WalletRetryModule),
    RedisModule,
  ],
  providers: [WalletAuditService, WalletAuditCleanupService],
  exports: [WalletAuditService],
})
export class WalletAuditModule {}

