import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WalletAuditService } from './wallet-audit.service';
import { WalletRetryService } from '@vector-games/game-core';
import { RedisService } from '../redis/redis.service';

/**
 * Monthly scheduler that deletes wallet audit and retry job records older than 2 months
 * Runs on the 1st of every month at 00:00:00 UTC
 * 
 * Uses distributed lock to prevent concurrent execution across multiple instances
 */
@Injectable()
export class WalletAuditCleanupService {
  private readonly logger = new Logger(WalletAuditCleanupService.name);
  private readonly LOCK_KEY = 'wallet-audit-cleanup-lock';
  private readonly LOCK_TTL_SECONDS = 3600; // 1 hour lock
  private readonly LAST_RUN_KEY = 'wallet-audit-cleanup-last-run';

  constructor(
    private readonly walletAuditService: WalletAuditService,
    @Inject(forwardRef(() => WalletRetryService))
    private readonly retryJobService: WalletRetryService,
    private readonly redisService: RedisService,
  ) {
    this.logger.log('Wallet audit cleanup scheduler initialized');
  }

  /**
   * Cron job: Runs on the 1st of every month at 00:00:00 UTC
   * Cron expression: "0 0 1 * *" = minute 0, hour 0, day 1, every month, any day of week
   */
  @Cron('0 0 1 * *', {
    name: 'wallet-audit-cleanup',
    timeZone: 'UTC',
  })
  async handleMonthlyCleanup() {
    this.logger.log(
      `[WALLET_AUDIT_CLEANUP_TRIGGERED] Monthly cleanup cron triggered at ${new Date().toISOString()}`,
    );
    await this.runCleanup();
  }

  /**
   * Run the cleanup process
   * Deletes all wallet audit and retry job records older than 2 months
   * Uses distributed lock to prevent concurrent execution
   */
  async runCleanup(): Promise<void> {
    // Acquire distributed lock to prevent concurrent processing
    const lockAcquired = await this.redisService.acquireLock(
      this.LOCK_KEY,
      this.LOCK_TTL_SECONDS,
    );

    if (!lockAcquired) {
      this.logger.debug(
        '[WALLET_AUDIT_CLEANUP_SKIPPED] Lock already held by another instance, skipping this run',
      );
      return;
    }

    try {
      // Check if we already ran today (prevent duplicate runs)
      const todayKey = this.getTodayKey();
      const lastRun = await this.redisService.get<string>(this.LAST_RUN_KEY);

      if (lastRun === todayKey) {
        this.logger.debug(
          `[WALLET_AUDIT_CLEANUP_SKIPPED] Already ran today (${todayKey}), skipping`,
        );
        return;
      }

      const now = new Date();

      // Calculate the cutoff date: 2 months before the current month
      // Example: If today is Dec 1, cutoff is Oct 1 (keeps Oct and Nov)
      const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      cutoffDate.setHours(0, 0, 0, 0);

      this.logger.log(
        `[WALLET_AUDIT_CLEANUP_START] Starting cleanup - deleting records before ${cutoffDate.toISOString()}`,
      );

      // Delete old wallet audit records
      const deletedAuditCount =
        await this.walletAuditService.deleteOlderThan(cutoffDate);

      // Delete old retry job records
      const deletedRetryCount =
        await this.retryJobService.deleteOlderThan(cutoffDate);

      // Store last run date in Redis (expires after 3 days)
      await this.redisService.set(this.LAST_RUN_KEY, todayKey, 3 * 24 * 60 * 60);

      this.logger.log(
        `[WALLET_AUDIT_CLEANUP_COMPLETE] Deleted ${deletedAuditCount} audit record(s) and ${deletedRetryCount} retry job(s) created before ${cutoffDate.toISOString()}`,
      );
    } catch (error) {
      this.logger.error(
        `[WALLET_AUDIT_CLEANUP_ERROR] Failed to run cleanup: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      // Always release the lock
      await this.redisService.releaseLock(this.LOCK_KEY);
    }
  }

  /**
   * Get today's key for tracking last run date
   */
  private getTodayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  }

  /**
   * Manually trigger cleanup (for testing or manual execution)
   */
  async manualCleanup(): Promise<{ auditCount: number; retryCount: number }> {
    this.logger.log('[WALLET_AUDIT_CLEANUP_MANUAL] Manual cleanup triggered');
    await this.runCleanup();
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    cutoffDate.setHours(0, 0, 0, 0);
    const auditCount = await this.walletAuditService.deleteOlderThan(cutoffDate);
    const retryCount = await this.retryJobService.deleteOlderThan(cutoffDate);
    return { auditCount, retryCount };
  }
}

