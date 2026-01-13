import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, LessThanOrEqual, In } from 'typeorm';
import {
  WalletRetryJob,
  WalletRetryJobStatus,
  WalletApiAction,
} from '@vector-games/game-core';

export interface CreateRetryJobParams {
  platformTxId: string;
  apiAction: WalletApiAction;
  agentId: string;
  userId: string;
  requestPayload: any;
  callbackUrl: string;
  roundId?: string;
  betAmount?: number | string;
  winAmount?: number | string;
  currency?: string;
  gamePayloads?: any;
  walletAuditId?: string;
  betId?: string;
  errorMessage?: string;
}

/**
 * Calculate next retry time based on attempt number and initial failure time
 * 
 * PRODUCTION Schedule: 5min → 15min → 30min → every 2h until 72h
 */
export function calculateNextRetryTime(
  attempt: number,
  initialFailureAt: Date,
): Date | null {
  // PRODUCTION MODE: 5min → 15min → 30min → every 2h until 72h
  const now = new Date();
  const elapsedMs = now.getTime() - initialFailureAt.getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  // First 3 attempts: fixed intervals
  if (attempt === 1) {
    return new Date(initialFailureAt.getTime() + 5 * 60 * 1000); // 5 min
  }
  if (attempt === 2) {
    return new Date(initialFailureAt.getTime() + 15 * 60 * 1000); // 15 min
  }
  if (attempt === 3) {
    return new Date(initialFailureAt.getTime() + 30 * 60 * 1000); // 30 min
  }

  // After 30 min: every 2 hours until 72 hours
  if (elapsedHours >= 72) {
    return null; // Expired, no more retries
  }

  // Calculate next 2-hour interval
  // After 30 min (0.5 hours), start 2-hour intervals
  const hoursSince30Min = elapsedHours - 0.5;
  const nextIntervalNumber = Math.ceil(hoursSince30Min / 2);
  const nextRetryHours = 0.5 + nextIntervalNumber * 2; // 0.5 + 2, 4, 6, 8...

  // Cap at 72 hours
  if (nextRetryHours >= 72) {
    return null; // Expired
  }

  return new Date(initialFailureAt.getTime() + nextRetryHours * 60 * 60 * 1000);
}

/**
 * Calculate maximum number of retries based on time limit
 * 
 * PRODUCTION MODE: 5min, 15min, 30min = 3 attempts
 * Then every 2h for 72h = (72 - 0.5) / 2 = ~35 more attempts
 * Total: 3 + 35 = 38 attempts max
 */
export function calculateMaxRetries(): number {
  // PRODUCTION MODE: 5min, 15min, 30min = 3 attempts
  // Then every 2h for 72h = (72 - 0.5) / 2 = ~35 more attempts
  // Total: 3 + 35 = 38 attempts max
  return 38;
}

@Injectable()
export class WalletRetryJobService {
  private readonly logger = new Logger(WalletRetryJobService.name);

  constructor(
    @InjectRepository(WalletRetryJob)
    private readonly repo: Repository<WalletRetryJob>,
  ) {
    this.logger.log(
      `[RETRY_MODE] Retry scheduler initialized with PRODUCTION schedule: 5min → 15min → 30min → every 2h until 72h`,
    );
  }

  /**
   * Create a new retry job
   * Prevents duplicate retry jobs for the same transaction
   */
  async createRetryJob(params: CreateRetryJobParams): Promise<WalletRetryJob> {
    try {
      // CRITICAL FIX #1: Check for existing active retry job to prevent duplicates
      const existingJob = await this.repo.findOne({
        where: {
          platformTxId: params.platformTxId,
          apiAction: params.apiAction,
          status: In([
            WalletRetryJobStatus.PENDING,
            WalletRetryJobStatus.PROCESSING,
          ]),
        },
      });

      if (existingJob) {
        this.logger.warn(
          `Duplicate retry job prevented: Existing job ${existingJob.id} for ${params.apiAction} txId=${params.platformTxId} status=${existingJob.status}`,
        );
        // Return existing job instead of creating duplicate
        return existingJob;
      }

      const initialFailureAt = new Date();
      const nextRetryAt = calculateNextRetryTime(1, initialFailureAt);

      if (!nextRetryAt) {
        throw new Error('Cannot create retry job: already expired');
      }

      const retryJob = this.repo.create({
        platformTxId: params.platformTxId,
        apiAction: params.apiAction,
        status: WalletRetryJobStatus.PENDING,
        retryAttempt: 0,
        maxRetries: calculateMaxRetries(),
        nextRetryAt,
        initialFailureAt,
        agentId: params.agentId,
        userId: params.userId,
        requestPayload: params.requestPayload,
        callbackUrl: params.callbackUrl,
        roundId: params.roundId,
        betAmount: params.betAmount ? String(params.betAmount) : undefined,
        winAmount: params.winAmount ? String(params.winAmount) : undefined,
        currency: params.currency,
        gamePayloads: params.gamePayloads,
        walletAuditId: params.walletAuditId,
        betId: params.betId,
        errorMessage: params.errorMessage,
      });

      const saved = await this.repo.save(retryJob);
      this.logger.log(
        `Retry job created: ${saved.id} for ${params.apiAction} txId=${params.platformTxId} nextRetryAt=${nextRetryAt.toISOString()}`,
      );
      return saved;
    } catch (err) {
      this.logger.error(
        `Failed to create retry job: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  /**
   * Find all retry jobs that are due for execution
   * CRITICAL FIX #2: Also finds stale PROCESSING jobs (stuck jobs recovery)
   */
  async findDueRetries(): Promise<WalletRetryJob[]> {
    const now = new Date();
    const staleProcessingThreshold = new Date(
      now.getTime() - 10 * 60 * 1000,
    ); // 10 minutes ago

    // Find   :
     // 1. PENDING jobs that are due (nextRetryAt <= now)
    // 2. PROCESSING jobs that are stale (updatedAt < 10 minutes ago)
    // This recovers jobs stuck in PROCESSING state (e.g., pod crashed)
    return this.repo
      .createQueryBuilder('job')
      .where(
        '(job.status = :pendingStatus AND job.nextRetryAt <= :now)',
        {
          pendingStatus: WalletRetryJobStatus.PENDING,
          now: now,
        },
      )
      .orWhere(
        '(job.status = :processingStatus AND job.updatedAt < :staleThreshold)',
        {
          processingStatus: WalletRetryJobStatus.PROCESSING,
          staleThreshold: staleProcessingThreshold,
        },
      )
      .orderBy('job.nextRetryAt', 'ASC')
      .addOrderBy('job.updatedAt', 'ASC') // Process oldest stale jobs first
      .take(500) // BOTTLENECK FIX: Increased from 100 to 500 jobs per batch
      .getMany();
  }

  /**
   * Update retry job status
   */
  async updateStatus(
    id: string,
    status: WalletRetryJobStatus,
  ): Promise<WalletRetryJob> {
    const retryJob = await this.repo.findOne({ where: { id } });
    if (!retryJob) {
      throw new Error(`Retry job not found: ${id}`);
    }

    retryJob.status = status;
    retryJob.updatedAt = new Date();

    if (status === WalletRetryJobStatus.PROCESSING) {
      retryJob.lastRetryAt = new Date();
    }

    return await this.repo.save(retryJob);
  }

  /**
   * Schedule next retry attempt
   */
  async scheduleNextRetry(
    id: string,
    nextAttempt: number,
    nextRetryAt: Date | null,
    errorMessage?: string,
  ): Promise<WalletRetryJob> {
    const retryJob = await this.repo.findOne({ where: { id } });
    if (!retryJob) {
      throw new Error(`Retry job not found: ${id}`);
    }

    if (!nextRetryAt) {
      // Expired - mark as EXPIRED
      retryJob.status = WalletRetryJobStatus.EXPIRED;
      retryJob.completedAt = new Date();
      retryJob.errorMessage = errorMessage || 'Retry expired after 72 hours';
      this.logger.warn(
        `Retry job expired: ${id} after ${retryJob.retryAttempt} attempts`,
      );
    } else {
      // Schedule next retry
      retryJob.status = WalletRetryJobStatus.PENDING;
      retryJob.retryAttempt = nextAttempt;
      retryJob.nextRetryAt = nextRetryAt;
      retryJob.errorMessage = errorMessage || null;
      this.logger.log(
        `Next retry scheduled: ${id} attempt=${nextAttempt} nextRetryAt=${nextRetryAt.toISOString()}`,
      );
    }

    retryJob.updatedAt = new Date();
    return await this.repo.save(retryJob);
  }

  /**
   * Mark retry job as success
   */
  async markSuccess(id: string): Promise<WalletRetryJob> {
    const retryJob = await this.repo.findOne({ where: { id } });
    if (!retryJob) {
      throw new Error(`Retry job not found: ${id}`);
    }

    retryJob.status = WalletRetryJobStatus.SUCCESS;
    retryJob.completedAt = new Date();
    retryJob.updatedAt = new Date();

    this.logger.log(
      `Retry job succeeded: ${id} after ${retryJob.retryAttempt} attempts`,
    );

    return await this.repo.save(retryJob);
  }

  /**
   * Mark retry job as expired
   */
  async markExpired(id: string, errorMessage?: string): Promise<WalletRetryJob> {
    const retryJob = await this.repo.findOne({ where: { id } });
    if (!retryJob) {
      throw new Error(`Retry job not found: ${id}`);
    }

    retryJob.status = WalletRetryJobStatus.EXPIRED;
    retryJob.completedAt = new Date();
    retryJob.errorMessage = errorMessage || 'Retry expired after 72 hours';
    retryJob.updatedAt = new Date();

    this.logger.warn(
      `Retry job expired: ${id} after ${retryJob.retryAttempt} attempts`,
    );

    return await this.repo.save(retryJob);
  }

  async findById(id: string): Promise<WalletRetryJob | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByPlatformTxId(
    platformTxId: string,
    apiAction?: WalletApiAction,
  ): Promise<WalletRetryJob[]> {
    const where: any = { platformTxId };
    if (apiAction) {
      where.apiAction = apiAction;
    }
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Delete records older than specified date
   * Used by cleanup scheduler
   */
  async deleteOlderThan(cutoffDate: Date): Promise<number> {
    try {
      const result = await this.repo.delete({
        createdAt: LessThan(cutoffDate),
      });
      this.logger.log(
        `Deleted ${result.affected || 0} retry job records older than ${cutoffDate.toISOString()}`,
      );
      return result.affected || 0;
    } catch (err) {
      this.logger.error(
        `Failed to delete old retry job records: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }
}

