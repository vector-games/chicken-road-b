import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WalletRetryJob, WalletRetryJobStatus } from '@vector-games/game-core';
import { RedisService } from '../redis/redis.service';
import { WalletRetryJobService, calculateNextRetryTime } from './wallet-retry-job.service';
import { WalletRetryProcessorService } from './wallet-retry-processor.service';

/**
 * Scheduler service that processes due retry jobs
 * Runs every minute to check for retries that are ready to execute
 * Uses distributed locking to ensure only one pod processes retries at a time
 */
@Injectable()
export class WalletRetrySchedulerService {
  private readonly logger = new Logger(WalletRetrySchedulerService.name);
  private readonly SCHEDULER_LOCK_KEY = 'wallet-retry-scheduler-lock';
  private readonly SCHEDULER_LOCK_TTL = 60; // 1 minute (cron runs every minute)

  constructor(
    private readonly retryJobService: WalletRetryJobService,
    private readonly retryProcessor: WalletRetryProcessorService,
    private readonly redisService: RedisService,
  ) {
    this.logger.log('Wallet retry scheduler initialized');
  }

  /**
   * Cron job: Runs every minute
   * Checks for retry jobs that are due for execution
   */
  @Cron('* * * * *', {
    name: 'wallet-retry-scheduler',
  })
  async processDueRetries() {
    this.logger.debug('[RETRY_SCHEDULER] Checking for due retries');

    // Acquire distributed lock to prevent multiple pods from processing
    const lockAcquired = await this.redisService.acquireLock(
      this.SCHEDULER_LOCK_KEY,
      this.SCHEDULER_LOCK_TTL,
    );

    if (!lockAcquired) {
      this.logger.debug(
        '[RETRY_SCHEDULER] Lock already held by another pod, skipping',
      );
      return;
    }

    try {
      // Find all retry jobs that are due
      const dueRetries = await this.retryJobService.findDueRetries();

      if (dueRetries.length === 0) {
        this.logger.debug('[RETRY_SCHEDULER] No due retries found');
        return;
      }

      this.logger.log(
        `[RETRY_SCHEDULER] Found ${dueRetries.length} due retry job(s)`,
      );

      // BOTTLENECK FIX: Process retries in parallel with concurrency limit
      // Process 10 jobs concurrently instead of sequentially
      const CONCURRENT_LIMIT = parseInt(
        process.env.RETRY_CONCURRENT_LIMIT || '10',
        10,
      ); // Default: 10 concurrent retries

      // Process in batches to respect concurrency limit
      for (let i = 0; i < dueRetries.length; i += CONCURRENT_LIMIT) {
        const batch = dueRetries.slice(i, i + CONCURRENT_LIMIT);
        await Promise.all(
          batch.map((retryJob) => this.processRetryJob(retryJob)),
        );
        this.logger.debug(
          `[RETRY_SCHEDULER] Processed batch ${Math.floor(i / CONCURRENT_LIMIT) + 1} (${batch.length} jobs)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[RETRY_SCHEDULER_ERROR] Failed to process due retries: ${error.message}`,
        error.stack,
      );
    } finally {
      // Always release the lock
      await this.redisService.releaseLock(this.SCHEDULER_LOCK_KEY);
    }
  }

  /**
   * Process a single retry job
   * Uses job-specific lock to prevent duplicate processing
   */
  private async processRetryJob(retryJob: WalletRetryJob): Promise<void> {
    // Job-specific lock key
    const jobLockKey = `retry-job-lock:${retryJob.platformTxId}:${retryJob.apiAction}`;
    const jobLockTTL = 300;

    // Acquire job-specific lock
    const lockAcquired = await this.redisService.acquireLock(
      jobLockKey,
      jobLockTTL,
    );

    if (!lockAcquired) {
      this.logger.warn(
        `[RETRY_JOB] Job already being processed by another pod: ${retryJob.id}`,
      );
      return;
    }

    try {
      // Double-check job status (might have been processed by another pod)
      const currentJob = await this.retryJobService.findById(retryJob.id);
      if (!currentJob) {
        this.logger.debug(
          `[RETRY_JOB] Job not found, skipping: ${retryJob.id}`,
        );
        return;
      }

      // Handle stale PROCESSING jobs (recovery mechanism)
      if (currentJob.status === WalletRetryJobStatus.PROCESSING) {
        this.logger.warn(
          `[RETRY_JOB] Recovering stale PROCESSING job: ${retryJob.id} txId=${retryJob.platformTxId} (pod likely crashed)`,
        );
        // Reset to PENDING to allow retry
        await this.retryJobService.updateStatus(
          retryJob.id,
          WalletRetryJobStatus.PENDING,
        );
      } else if (currentJob.status !== WalletRetryJobStatus.PENDING) {
        this.logger.debug(
          `[RETRY_JOB] Job status changed, skipping: ${retryJob.id} status=${currentJob.status}`,
        );
        return;
      }

      // Update status to PROCESSING
      await this.retryJobService.updateStatus(
        retryJob.id,
        WalletRetryJobStatus.PROCESSING,
      );

      this.logger.log(
        `[RETRY_JOB] Processing retry: ${retryJob.id} attempt=${retryJob.retryAttempt + 1} txId=${retryJob.platformTxId}`,
      );

      // Execute the retry
      const result = await this.retryProcessor.executeRetry(retryJob);

      // Handle result
      if (result.success) {
        // Success - mark job as completed
        await this.retryJobService.markSuccess(retryJob.id);
        this.logger.log(
          `[RETRY_JOB] Retry succeeded: ${retryJob.id} after ${retryJob.retryAttempt + 1} attempts`,
        );
      } else {
        // Failure - schedule next retry or mark as expired
        const nextAttempt = retryJob.retryAttempt + 1;
        const nextRetryAt = calculateNextRetryTime(
          nextAttempt,
          retryJob.initialFailureAt,
        );

        if (nextRetryAt) {
          // Schedule next retry
          await this.retryJobService.scheduleNextRetry(
            retryJob.id,
            nextAttempt,
            nextRetryAt,
            result.errorMessage,
          );
          this.logger.log(
            `[RETRY_JOB] Next retry scheduled: ${retryJob.id} attempt=${nextAttempt} nextRetryAt=${nextRetryAt.toISOString()}`,
          );
        } else {
          // Expired - mark as expired
          await this.retryJobService.markExpired(
            retryJob.id,
            result.errorMessage || 'Retry expired after 72 hours',
          );
          this.logger.warn(
            `[RETRY_JOB] Retry expired: ${retryJob.id} after ${retryJob.retryAttempt + 1} attempts`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `[RETRY_JOB_ERROR] Failed to process retry job ${retryJob.id}: ${error.message}`,
        error.stack,
      );

      // Try to reschedule on error (unless expired)
      try {
        const nextAttempt = retryJob.retryAttempt + 1;
        const nextRetryAt = calculateNextRetryTime(
          nextAttempt,
          retryJob.initialFailureAt,
        );

        if (nextRetryAt) {
          await this.retryJobService.scheduleNextRetry(
            retryJob.id,
            nextAttempt,
            nextRetryAt,
            error.message,
          );
        } else {
          await this.retryJobService.markExpired(
            retryJob.id,
            error.message,
          );
        }
      } catch (rescheduleError) {
        this.logger.error(
          `[RETRY_JOB_ERROR] Failed to reschedule after error: ${rescheduleError.message}`,
        );
      }
    } finally {
      // Always release the job lock
      await this.redisService.releaseLock(jobLockKey);
    }
  }
}

